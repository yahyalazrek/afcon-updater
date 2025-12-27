const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

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

    // Truncate to avoid token limits, but ensure we keep enough for the bracket
    const htmlText = response.data.substring(0, 500000);

    console.log("Asking Gemini to parse...");
    
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" }); 
    
    // --- TASK 1: GET STANDINGS ---
    console.log("1. Parsing Standings...");
    const standingsPrompt = `
      I am providing the raw HTML/Text of the AFCON 2025 Wikipedia page.
      
      YOUR TASK:
      Extract the "Group stage" tables into a JSON object.
      
      REQUIRED JSON STRUCTURE:
      {
          "standings": [
              {
                  "group": "A",
                  "team": [
                      {
                          "name": "Country Name",
                          "image": "https://flagsapi.com/XX/flat/64.png",
                          "info": {
                              "win": "0",
                              "draw": "0",
                              "lose": "0"
                          }
                      }
                  ]
              }
          ]
      }

      CRITICAL RULES:
      1. Derive 2-letter ISO Country Code for flags (e.g. Morocco=MA). Replace XX.
      2. 'win', 'draw', 'lose' must be STRINGS.
      3. Return ONLY raw JSON. No Markdown.
      
      HTML SOURCE:
      ${htmlText}
    `;

    const standingsResult  = await model.generateContent(standingsPrompt);
    const standingsText = standingsResult.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
    
    let standingsJson;
    try {
        standingsJson = JSON.parse(standingsText);
    } catch (e) {
        console.error("Gemini returned invalid JSON for Standings");
        standingsJson = { standings: [] };
    }

    // --- TASK 2: GET GAMES ---
    console.log("Waiting 60 seconds to reset API quota...");
    await sleep(60000);

    console.log("2. Parsing Games...");
    const gamesPrompt = `
      Using the HTML provided, extract ALL matches/games.
      
      REQUIRED JSON STRUCTURE:
      {
          "games": [
              {
                  "team": [
                      { "name": "Team A Name", "image": "https://flagsapi.com/XX/flat/64.png", "score": "1" },
                      { "name": "Team B Name", "image": "https://flagsapi.com/YY/flat/64.png", "score": "2" }
                  ],
                  "info": {
                      "date": "DD-MM-YYYY",
                      "time": "Full time" 
                  }
              }
          ]
      }

      RULES:
      1. Flags: https://flagsapi.com/{ISO_CODE}/flat/64.png.
      2. If game hasn't happened, score is "-" and time is HH:MM.
      3. If game is done, time is "Full time".
      4. If penalties: "1 (4)". 
      5. Date format: DD-MM-YYYY.
      6. Return ONLY raw JSON.

      HTML: ${htmlText}
    `;

    const gamesResult = await model.generateContent(gamesPrompt);
    const gamesText = gamesResult.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
    
    let gamesJson;
    try {
        gamesJson = JSON.parse(gamesText);
    } catch(e) {
        console.error("Failed to parse Games JSON");
        gamesJson = { games: [] }; 
    }

    // --- TASK 3: GET BRACKET ---
    console.log("Waiting 60 seconds to reset API quota...");
    await sleep(60000);
    
    console.log("3. Parsing Bracket...");
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

      HTML: ${htmlText}
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

    // --- TASK 4: MERGE AND SAVE ---
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