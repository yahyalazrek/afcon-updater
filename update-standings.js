const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// Constantes
const dateTimeSlots = [
    "21-12-2025 20:00", "22-12-2025 15:00", "22-12-2025 18:00", "22-12-2025 21:00",
    "23-12-2025 12:30", "23-12-2025 15:00", "23-12-2025 17:30", "23-12-2025 20:00",
    "24-12-2025 12:30", "24-12-2025 15:00", "24-12-2025 17:30", "24-12-2025 20:00",
    "26-12-2025 13:30", "26-12-2025 16:00", "26-12-2025 18:30", "26-12-2025 21:00",
    "27-12-2025 12:30", "27-12-2025 15:00", "27-12-2025 17:30", "27-12-2025 20:00",
    "28-12-2025 12:30", "28-12-2025 15:00", "28-12-2025 17:30", "28-12-2025 20:00",
    "29-12-2025 17:00", "29-12-2025 20:00", 
    "30-12-2025 16:00", "30-12-2025 19:00", 
    "31-12-2025 16:00", "31-12-2025 19:00", 
    "03-01-2026 17:00", "03-01-2026 20:00",
    "04-01-2026 17:00", "04-01-2026 20:00",
    "05-01-2026 17:00", "05-01-2026 20:00",
    "06-01-2026 17:00", "06-01-2026 20:00",
    "09-01-2026 17:00", "09-01-2026 21:00",
    "10-01-2026 17:00", "10-01-2026 20:00",
    "14-01-2026 18:00", "14-01-2026 21:00",
    "17-01-2026 17:00", "18-01-2026 20:00"
];

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

    // ---- EXTRACT STANDINGS ----
    console.log("Extracting Standings...");
    const standingsJson = { standings: [] };
    const groupNames = ['A', 'B', 'C', 'D', 'E', 'F'];

    // Find valid standings tables
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

        table.find('tr').slice(1).each((i, row) => {
            const cols = $(row).find('th, td');

            // Need enough columns and ignore "Advance to..." separator rows
            if (cols.length < 9 || $(row).text().includes('Advance to')) return;

            // Extract Name
            const teamCell = $(cols[1]);
            let teamName = teamCell.find('a').not('.image').first().text().trim();
            if (!teamName) teamName = teamCell.text().replace(/\(H\)/g, '').trim();

            // Extract Flag
            const code = countryCodes[teamName] || "XX";
            const flagUrl = `https://flagsapi.com/${code}/flat/64.png`;

            // Extract Stats (W/D/L)
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

        // FIX: Use standingsJson, not standingsData
        standingsJson.standings.push(groupObj);
    });

    console.log(`Standings extracted: ${standingsJson.standings.length} groups.`);

    // ---- EXTRACT GAMES ----
    console.log("Extracting Games...");
    const gamesJson = { "games": [] };

    // FIX: Wikipedia uses div.footballbox for matches, not a single wikitable.
    // We select all football boxes.
    const matchBoxes = $('div.footballbox');
    
    let slotIndex = 0; 
    let matchIndex = 0;

    matchBoxes.each((i, el) => {
        const box = $(el);
        
        // --- 1. Map Match to Time Slot (Your custom logic) ---
        if (slotIndex >= dateTimeSlots.length) slotIndex = dateTimeSlots.length - 1;
        
        const currentSlot = dateTimeSlots[slotIndex];
        const [dateStr, timeStr] = currentSlot.split(' ');

        // Increment logic based on your rules
        if (matchIndex < 24) {
            slotIndex++;
        } else if (matchIndex >= 24 && matchIndex < 36) {
            if (matchIndex % 2 !== 0) {
                slotIndex++;
            }
        } else {
            slotIndex++;
        }
        matchIndex++;

        // --- 2. Parse Data from footballbox ---
        const t1Name = box.find('.fhome').text().replace(/\n/g, '').trim();
        const t2Name = box.find('.faway').text().replace(/\n/g, '').trim();
        const scoreText = box.find('.fscore').text().replace(/\n/g, '').trim();
        
        // --- 3. Determine Scores & Status ---
        let score1 = "0";
        let score2 = "0";
        let displayTime = timeStr; 

        // Check if match has a score (e.g., "2–1")
        const scoreMatch = scoreText.match(/(\d+)[\u2013\-](\d+)/);
        
        if (scoreMatch) {
            score1 = scoreMatch[1];
            score2 = scoreMatch[2];
            displayTime = "Full time";
        } else {
            score1 = "-";
            score2 = "-";
        }

        // --- 4. Get Images ---
        const t1Code = countryCodes[t1Name] || "XX";
        const t2Code = countryCodes[t2Name] || "XX";
        const t1Img = t1Code !== "XX" ? `https://flagsapi.com/${t1Code}/flat/64.png` : "";
        const t2Img = t2Code !== "XX" ? `https://flagsapi.com/${t2Code}/flat/64.png` : "";

        // --- 5. Build Object ---
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