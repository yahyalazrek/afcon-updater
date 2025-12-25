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

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    // Clean string
    const jsonString = text.replace(/```json/g, "").replace(/```/g, "").trim();
    
    let jsonData;
    try {
        jsonData = JSON.parse(jsonString);
    } catch (e) {
        console.error("Gemini returned invalid JSON:", jsonString);
        throw new Error("Invalid JSON parsed");
    }

    console.log("Saving to Firestore...");
    
    await db.collection('competitions').doc('afcon_2025').set(jsonData);

    console.log("Done! Firestore document updated.");

  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

run();