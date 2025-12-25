const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// 1. Setup Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: serviceAccount.project_id + ".appspot.com" 
});

// 2. Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
  try {
    console.log("Fetching raw data from Wikipedia...");
    
    const url = "https://en.wikipedia.org/wiki/2025_Africa_Cup_of_Nations";
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    const htmlText = response.data.substring(0, 500000); 

    console.log("Asking Gemini to parse...");
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const prompt = `
      I am providing the raw HTML/Text of the AFCON 2025 Wikipedia page.
      
      YOUR TASK:
      Look for the "Group stage" tables (Group A, Group B, etc.).
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
           },
           ... (Repeat for Groups B, C, D, E, F)
        ]
      }

      RULES:
      1. If the tables are empty or populated with "0", return them as 0.
      2. Return ONLY the raw JSON string. No Markdown formatting (no \`\`\`json).
      3. If you absolutely cannot find the data, return an empty groups array.

      HTML SOURCE:
      ${htmlText}
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    // Clean string just in case Gemini adds markdown
    const jsonString = text.replace(/```json/g, "").replace(/```/g, "").trim();
    
    // Validate JSON before uploading
    let jsonData;
    try {
        jsonData = JSON.parse(jsonString);
    } catch (e) {
        console.error("Gemini returned invalid JSON:", jsonString);
        throw new Error("Invalid JSON parsed");
    }

    console.log("Uploading to Firebase Storage...");
    const bucket = admin.storage().bucket();
    const file = bucket.file('afcon_standings.json');
    
    await file.save(JSON.stringify(jsonData, null, 2), {
      contentType: 'application/json',
      metadata: { cacheControl: 'public, max-age=300' }
    });

    console.log("Done! File updated.");

  } catch (error) {
    console.error("Error:", error.message);
    if (error.response) console.error("Status:", error.response.status);
    process.exit(1);
  }
}

run();