const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// Constantes
const countryCodes = {
    "Morocco": "MA", "Senegal": "SN", "Egypt": "EG", "Algeria": "DZ",
    "Nigeria": "NG", "Mali": "ML", "Ivory Coast": "CI", "Côte d'Ivoire": "CI",
    "Cameroon": "CM", "Tunisia": "TN", "South Africa": "ZA", "Burkina Faso": "BF",
    "Ghana": "GH", "DR Congo": "CD", "Democratic Republic of the Congo": "CD",
    "Guinea": "GN", "Cape Verde": "CV", "Angola": "AO", "Zambia": "ZM",
    "Equatorial Guinea": "GQ", "Mauritania": "MR", "Gambia": "GM", "Mozambique": "MZ",
    "Namibia": "NA", "Tanzania": "TZ", "Guinea-Bissau": "GW", "Gabon": "GA",
    "Zimbabwe": "ZW", "Uganda": "UG", "Benin": "BJ", "Sudan": "SD",
    "Comoros": "KM", "Togo": "TG", "Libya": "LY", "Rwanda": "RW",
    "Congo": "CG", "Sierra Leone": "SL", "Ethiopia": "ET", "Madagascar": "MG",
    "Botswana": "BW", "Kenya": "KE", "Malawi": "MW", "Niger": "NE",
    "Central African Republic": "CF", "Liberia": "LR", "Burundi": "BI"
};

// 1. Setup Firebase Admin
// Ensure environment variables are set correctly
if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.GEMINI_API_KEY) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT or GEMINI_API_KEY environment variables");
    process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 2. Setup Gemini (FIX: Updated model name)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
  try {
    console.log("Fetching raw data from Wikipedia...");
    const url = "https://en.wikipedia.org/wiki/2025_Africa_Cup_of_Nations";
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });

    const $ = cheerio.load(response.data);

    console.log("Extracting Standings...");
    const standingsJson = { standings: [] };
    const groupNames = ['A', 'B', 'C', 'D', 'E', 'F'];

    const tables = $('table.wikitable').filter((i, el) => {
        const txt = $(el).text();
        return txt.includes('Pos') && txt.includes('Team') && txt.includes('Pts');
    });

    tables.each((index, element) => {
        if (index >= 6) return; // Only Groups A-F

        const table = $(element);
        const currentGroup = groupNames[index];
        
        const groupObj = {
            group: currentGroup,
            team: [] 
        };

        // .slice(1) skips the Header row.
        table.find('tr').slice(1).each((i, row) => {
            const cols = $(row).find('th, td');

            // We only check if there are enough columns to be a valid team row.
            // Some rows might be "separator" rows, but they usually have fewer columns or are hidden.
            if (cols.length < 8) return; 

            // Extract Name
            // In some tables Col 0 is Pos, Col 1 is Team.
            const teamCell = $(cols[1]);
            let teamName = teamCell.find('a').not('.image').first().text().trim();
            
            // Fallback if no link found (e.g. host country sometimes)
            if (!teamName) teamName = teamCell.text().replace(/\(H\)/g, '').replace(/\(.*\)/, '').trim();

            if (!teamName) return; // Skip if no name found

            // Extract Flag
            const code = countryCodes[teamName] || "XX";
            const flagUrl = `https://flagsapi.com/${code}/flat/64.png`;

            // Extract Stats (W/D/L) - Standard Wiki: Pos, Team, Pld, W, D, L
            const winVal = $(cols[3]).text().trim();
            const drawVal = $(cols[4]).text().trim();
            const loseVal = $(cols[5]).text().trim();

            const teamData = {
                name: teamName,
                image: flagUrl,
                info: {
                    win: winVal,
                    draw: drawVal,
                    lose: loseVal
                }
            };

            groupObj.team.push(teamData);
        });

        standingsJson.standings.push(groupObj);
    });

    console.log(`Standings extracted: ${standingsJson.standings.length} groups.`);

    // ---- EXTRACT GAMES ----
    console.log("Extracting Games...");
    const gamesJson = { "games": [] };

    const matchBoxes = $('div.footballbox');
    
    // Helper to format Wikipedia dates (e.g. "21 December 2025" -> "21-12-2025")
    const monthMap = {
        "January": "01", "February": "02", "March": "03", "April": "04", 
        "May": "05", "June": "06", "July": "07", "August": "08", 
        "September": "09", "October": "10", "November": "11", "December": "12"
    };

    const parseWikiDate = (rawDate) => {
        if (!rawDate) return "";
        
        // Regex to find: Digits + Space + Word + Space + 4 Digits
        // Example: Matches "30 December 2025" inside "30 December 2025 (2025-12-30)"
        const match = rawDate.match(/(\d+)\s+([a-zA-Z]+)\s+(\d{4})/);

        if (!match) return rawDate.trim(); // Fallback if format is weird

        let day = match[1];
        const monthName = match[2];
        const year = match[3];

        // Ensure day is 2 digits (e.g., "5" -> "05")
        if (day.length === 1) day = "0" + day;

        // Convert month name to number
        let month = Object.keys(monthMap).find(m => m.startsWith(monthName)) 
                    ? monthMap[Object.keys(monthMap).find(m => m.startsWith(monthName))] 
                    : "00";

        return `${day}-${month}-${year}`;
    };

    matchBoxes.each((i, el) => {
        const box = $(el);
        
        // --- 1. Scrape Date & Time Directly ---
        const dateRaw = box.find('.fdate').text();
        const timeRaw = box.find('.ftime').text();
        
        // Convert to your desired format
        const dateStr = parseWikiDate(dateRaw);
        
        // Use the scraped time (e.g. "20:00") or default if missing
        let displayTime = timeRaw ? timeRaw.trim() : "00:00";

        // --- 2. Parse Teams & Scores ---
        const t1Name = box.find('.fhome').text().replace(/\n/g, '').trim();
        const t2Name = box.find('.faway').text().replace(/\n/g, '').trim();
        const scoreText = box.find('.fscore').text().replace(/\n/g, '').trim();
        
        let score1 = "0";
        let score2 = "0";

        // Check if match has a score (e.g., "2–1" or "2-1")
        const scoreMatch = scoreText.match(/(\d+)[\u2013\-](\d+)/);
        
        if (scoreMatch) {
            score1 = scoreMatch[1];
            score2 = scoreMatch[2];
            displayTime = "Full time"; 
        } else {
            score1 = "-";
            score2 = "-";
        }

        // --- 3. Get Images ---
        const t1Code = countryCodes[t1Name] || "XX";
        const t2Code = countryCodes[t2Name] || "XX";
        const t1Img = t1Code !== "XX" ? `https://flagsapi.com/${t1Code}/flat/64.png` : "";
        const t2Img = t2Code !== "XX" ? `https://flagsapi.com/${t2Code}/flat/64.png` : "";

        // --- 4. Push to Array ---
        gamesJson.games.push({
            "team": [
                { "name": t1Name, "image": t1Img, "score": score1 },
                { "name": t2Name, "image": t2Img, "score": score2 }
            ],
            "info": {
                "date": dateStr,
                "time": displayTime
            }
        });
    });

    // --- 5. Sort Chronologically (Optional but recommended) ---
    // Since Wiki groups matches by Group (A, B, C...), the dates will be mixed.
    // This sort ensures the output is ordered by date.
    gamesJson.games.sort((a, b) => {
        const [d1, m1, y1] = a.info.date.split('-');
        const [d2, m2, y2] = b.info.date.split('-');
        
        const dateA = new Date(`${y1}-${m1}-${d1}T${a.info.time}:00`);
        const dateB = new Date(`${y2}-${m2}-${d2}T${b.info.time}:00`);
        
        return dateA - dateB;
    });

    console.log(`Games extracted: ${gamesJson.games.length}`);

    // ---- PARSE BRACKET (GEMINI) ----
    console.log("Asking Gemini to parse Bracket...");
    
    // Find the bracket section specifically
    const bracketTable = $('table').filter((i, el) => {
        const text = $(el).text();
        return text.includes('Round of 16') && 
               (text.includes('Quarter-finals') || text.includes('Quarterfinals'));
    });
    
    const bracketData = bracketTable.length ? bracketTable.prop('outerHTML') : "";
    let bracketJson = { bracket: [] };

    if (bracketData) {
        // FIX: Update model name
        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" }); 
        
        const bracketPrompt = `
          Extract the Knockout Stage Bracket from this HTML.
          Return ONLY valid JSON.
          
          STRUCTURE:
          {
              "bracket": [
                  {
                      "name": "Round of 16",
                      "games": [
                          {
                              "team": [
                                  { "name": "Team A", "image": "https://flagsapi.com/XX/flat/64.png", "score": "1" },
                                  { "name": "Team B", "image": "https://flagsapi.com/YY/flat/64.png", "score": "2" }
                              ]
                          }
                      ]
                  },
                  // Include: Quarter-finals, Semi-finals, Third place play-off, Final
              ]
          }

          RULES:
          1. Convert Team Names to ISO codes for the image URL (Morocco->MA, etc).
          2. If score is unknown, use "-". If team is unknown, name="Winner Group A" and image="".
          
          HTML: ${bracketData}
        `;

        try {
            const bracketResult = await model.generateContent(bracketPrompt);
            const bracketText = bracketResult.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
            bracketJson = JSON.parse(bracketText);
        } catch(e) {
            console.error("Gemini Parsing Failed:", e.message);
        }
    } else {
        console.log("No bracket table found in HTML.");
    }

    // --- MERGE AND SAVE ---
    console.log("Saving to Firestore...");
    
    const finalData = {
        last_updated: new Date().toISOString(),
        standings: standingsJson.standings,
        games: gamesJson.games,
        bracket: bracketJson.bracket || []
    };

    await db.collection('competitions').doc('afcon_2025').set(finalData, { merge: true });

    console.log("Done! Database updated.");

  } catch (error) {
    console.error("Fatal Error:", error);
    process.exit(1);
  }
}

run();