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

    const htmlText = response.data.substring(0, 500000); 

    console.log("Asking Gemini to parse...");
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
	// --- TASK 1: GET STANDINGS ---
	console.log("1. Parsing Standings...");
    const prompt = `
      I am providing the raw HTML/Text of the AFCON 2025 Wikipedia page.
      
      YOUR TASK:
      Extract the "Group stage" tables into a JSON object matching the EXACT structure below.
      
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
              // ... Repeat for all groups found
          ]
      }

      CRITICAL RULES:
      1. **Flag Images**: You must derive the 2-letter ISO Country Code for each country (e.g., Morocco = MA, Senegal = SN). Replace 'XX' in the URL 'https://flagsapi.com/XX/flat/64.png' with that code.
      2. **Data Types**: 'win', 'draw', 'lose' must be STRINGS (e.g., "2", not 2).
      3. **Missing Data**: If the group has not started, use "0" for stats.
      4. **Output**: Return ONLY the raw JSON string. No Markdown (\`\`\`).
      
      HTML SOURCE:
      ${htmlText}
    `;

    const standingsResult  = await model.generateContent(prompt);
    const standingsText = standingsResult.response.text();
    
    // Clean string
    const standingsJsonString = standingsText.replace(/```json/g, "").replace(/```/g, "").trim();
    
    let standingsJson;
    try {
        standingsJson = JSON.parse(standingsJsonString);
    } catch (e) {
        console.error("Gemini returned invalid JSON:", standingsJsonString);
        throw new Error("Invalid JSON parsed");
    }

	// --- TASK 2: GET GAMES ---
    console.log("2. Parsing Games...");
    const gamesPrompt = `
      Using the HTML provided, extract ALL matches/games (Group stage and Knockouts if available).
      
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
      1. **Flags**: Convert country name to 2-letter ISO code (e.g. Morocco->MA, USA->US). Format: https://flagsapi.com/{ISO}/flat/64.png.
      2. **Score**: If the game hasn't happened yet, set "score" to "-" and set "time" to the scheduled time (e.g. "20:00").
      3. **Finished**: If game is done, set "time" to "Full time".
      4. **Date**: Format dates as DD-MM-YYYY.
      5. Return ONLY raw JSON.

      HTML: ${htmlText}
    `;

    const gamesResult = await model.generateContent(gamesPrompt);
    const gamesText = gamesResult.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
    
    let gamesJson;
    try {
        gamesJson = JSON.parse(gamesText);
    } catch(e) {
        console.error("Failed to parse Games JSON", gamesText);
        gamesJson = { games: [] }; // Fallback
    }

    // --- TASK 3: MERGE AND SAVE ---
    console.log("Saving to Firestore...");
    
    const finalData = {
        last_updated: new Date().toISOString(),
        standings: standingsJson.standings,
        games: gamesJson.games
    };

    await db.collection('competitions').doc('afcon_2025').set(finalData, { merge: true });

    console.log("Done! Database updated with Standings and Games.");

  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

run();