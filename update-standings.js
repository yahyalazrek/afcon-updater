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
        "29-12-2025 17:00", "29-12-2025 20:00", // Last Group Games (Simultaneous)
        "30-12-2025 16:00", "30-12-2025 19:00", // Last Group Games (Simultaneous)
        "31-12-2025 16:00", "31-12-2025 19:00", // Last Group Games (Simultaneous)
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
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Initialize Firestore
const db = admin.firestore();

// 2. Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// UTILITY: Sleep function to avoid Rate Limits (429 Errors)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

    // Load HTML into Cheerio
    const $ = cheerio.load(response.data);

    // Find the bracket table
    // We filter through all tables to find the one containing the specific bracket headers
    const bracketTable = $('table').filter((i, el) => {
        const text = $(el).text();
        return text.includes('Round of 16') && 
                text.includes('Quarter-finals') && 
                text.includes('Semi-finals');
    });

    // Get the HTML string of that table
    const bracketData = bracketTable.prop('outerHTML');
    console.log(bracketData);

    // ---- EXTRACT STANDINGS ----
    const standingsJson = { standings: [] };
    const groupNames = ['A', 'B', 'C', 'D', 'E', 'F'];

    // Find valid standings tables
    const tables = $('table.wikitable').filter((i, el) => {
        const txt = $(el).text();
        return txt.includes('Pos') && txt.includes('Team') && txt.includes('Pts');
    });

    tables.each((index, element) => {
        // Only process the first 6 tables (Groups A-F)
        if (index >= 6) return;

        const table = $(element);
        const currentGroup = groupNames[index];
        
        const groupObj = {
            group: currentGroup,
            team: [] // User requested "team" (singular) as the array key
        };

        // Iterate rows, skipping the header
        table.find('tr').slice(1).each((i, row) => {
            const cols = $(row).find('th, td');

            // Ensure row has enough columns
            if (cols.length < 9) return;

            // --- 1. Extract Name ---
            // Try to find the link text, otherwise use full text and remove "(H)"
            const teamCell = $(cols[1]);
            let teamName = teamCell.find('a').not('.image').first().text().trim();
            if (!teamName) teamName = teamCell.text().replace('(H)', '').trim();

            // --- 2. Extract Flag Image ---
            // Get the src, ensure it has https prefix
            const code = countryCodes[teamName] || "XX";
            const flagUrl = `https://flagsapi.com/${code}/flat/64.png`;

            // --- 3. Extract Info (Win/Draw/Lose) ---
            // Based on table structure: Col 3=W, 4=D, 5=L
            const winVal = $(cols[3]).text().trim();
            const drawVal = $(cols[4]).text().trim();
            const loseVal = $(cols[5]).text().trim();

            // Build the team object
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

        standingsData.standings.push(groupObj);
    });

    // Output the standings Data
    console.log(JSON.stringify(standingsJson, null, 4));

    // ---- EXTRACT GAMES ----
    const gamesJson = { "games": [] };

    // Select the specific table containing match results
    const matchTable = $('table.wikitable').filter((i, el) => {
        const h = $(el).find('th').text();
        return h.includes('Team 1') && h.includes('Result') && h.includes('Team 2');
    }).first();

    let matchIndex = 0; // Tracks the actual match number (0 to 51)
    let slotIndex = 0;  // Tracks position in your dateTimeSlots array (0 to 45)

    matchTable.find('tr').each((i, row) => {
        const tds = $(row).find('td');
        if (tds.length === 0) return; // Skip headers

        // --- 1. Map Match to Time Slot ---
        // Logic: 
        // Matches 0-23 (First 24 games): 1 game per slot
        // Matches 24-35 (Last 12 group games): 2 games per slot
        // Matches 36-51 (Knockouts): 1 game per slot
        
        // Safety check
        if (slotIndex >= dateTimeSlots.length) slotIndex = dateTimeSlots.length - 1;
        
        const currentSlot = dateTimeSlots[slotIndex];
        const [dateStr, timeStr] = currentSlot.split(' ');

        // Increment logic
        if (matchIndex < 24) {
            // First 2 rounds of groups: Unique slots
            slotIndex++;
        } else if (matchIndex >= 24 && matchIndex < 36) {
            // Last round of groups: Simultaneous (every 2 matches consume 1 slot)
            // If matchIndex is odd (25, 27...), we move to next slot after this.
            // If matchIndex is even (24, 26...), we stay on same slot for next iteration.
            if (matchIndex % 2 !== 0) {
                slotIndex++;
            }
        } else {
            // Knockouts: Unique slots again
            slotIndex++;
        }
        
        matchIndex++;

        // --- 2. Parse Wiki Data ---
        // Adjust column offset for rowspan "Stage" column
        let colOffset = 0;
        if (tds.length >= 5) colOffset = 1;      
        else if (tds.length === 4) colOffset = 0; 
        else return; 

        let t1Name = $(tds[0 + colOffset]).text().replace(/\n/g, '').trim().replace(/\[.*\]/, '');
        let scoreText = $(tds[1 + colOffset]).text().replace(/\n/g, '').trim();
        let t2Name = $(tds[2 + colOffset]).text().replace(/\n/g, '').trim().replace(/\[.*\]/, '');

        // --- 3. Determine Scores & Status ---
        let score1 = "0";
        let score2 = "0";
        let displayTime = timeStr; // Default to the scheduled HH:mm

        const scoreMatch = scoreText.match(/(\d+)[\u2013\-](\d+)/);
        if (scoreMatch) {
            score1 = scoreMatch[1];
            score2 = scoreMatch[2];
            displayTime = "Full time"; // Override time if match is finished
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
                {
                    "name": t1Name,
                    "image": t1Img,
                    "score": score1
                },
                {
                    "name": t2Name,
                    "image": t2Img,
                    "score": score2
                }
            ],
            "info": {
                "date": dateStr,
                "time": displayTime
            }
        });
    });

    console.log(JSON.stringify(gamesJson, null, 4));

    console.log("Asking Gemini to parse...");
    
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" }); 
    
    // --- Parse Bracket ---
    console.log("Parsing Bracket...");
    const bracketPrompt = `
      Using the HTML provided, extract the Knockout Stage Bracket.
      
      REQUIRED JSON STRUCTURE:
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
                      // ... more games
                  ]
              },
              {
                  "name": "Quarter-finals",
                  "games": []
              },
              {
                  "name": "Semi-finals",
                  "games": []
              },
              {
                  "name": "Third place play-off",
                  "games": []
              },
              {
                  "name": "Final",
                  "games": []
              }
          ]
      }

      RULES:
      1. Structure: Follow the exact structure above.
      2. Flags: Convert country name to 2-letter ISO code (e.g., Morocco->MA). Format: https://flagsapi.com/{ISO}/flat/64.png. 
         - If the team is not known yet (e.g. "Winner Group A"), set image to empty string "" and name to "Winner Group A".
      3. Scores: 
         - If played: "3", "2".
         - If penalties: "1 (4)". 
         - If not played: "-".
      4. Data extraction: Look for the visual bracket or the knockout stage schedule in the HTML.
      5. Output: Return ONLY the raw JSON string. No Markdown.

      HTML: ${bracketData}
    `;

    const bracketResult = await model.generateContent(bracketPrompt);
    const bracketText = bracketResult.response.text().replace(/```json/g, "").replace(/```/g, "").trim();

    let bracketJson;
    try {
        bracketJson = JSON.parse(bracketText);
    } catch(e) {
        console.error("Failed to parse Bracket JSON", bracketText);
        bracketJson = { bracket: [] };
    }

    // --- MERGE AND SAVE ---
    console.log("Saving to Firestore...");
    
    const finalData = {
        last_updated: new Date().toISOString(),
        standings: standingsJson.standings,
        games: gamesJson.games,
        bracket: bracketJson.bracket
    };

    await db.collection('competitions').doc('afcon_2025').set(finalData, { merge: true });

    console.log("Done! Database updated with Standings, Games, and Bracket.");

  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

run();