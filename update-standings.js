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
      Look for the "Group stage" tables.
      Extract the current standings into a valid JSON object.
      
      REQUIRED JSON STRUCTURE:
      {
        "last_updated": "${new Date().toISOString()}",
        "groups": [
           { 
             "name": "Group A", 
             "teams": [
               { "rank": 1, "country": "Country Name", "points": 0, "played": 0, "gd": 0 }
             ] 
           }
        ]
      }

      RULES:
      1. Return ONLY the raw JSON string. No Markdown formatting (no \`\`\`json).
      2. If you cannot find specific data, return an empty structure or 0s.
      
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