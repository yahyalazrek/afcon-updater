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
    console.log("Fetching raw data...");
    const url = "https://en.wikipedia.org/wiki/2025_Africa_Cup_of_Nations#Group_stage";
    const response = await axios.get(url);
    const htmlText = response.data.substring(0, 60000);

    console.log("Asking Gemini to parse...");
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
		You are parsing a Wikipedia page about AFCON 2025.

		Extract ONLY the GROUP STAGE TABLES.

		Return a valid JSON object exactly in this format:
		{
		"last_updated": "${new Date().toISOString()}",
		"groups": [
			{
			"name": "Group A",
			"teams": [
				{
				"rank": 1,
				"country": "Morocco",
				"played": 0,
				"won": 0,
				"drawn": 0,
				"lost": 0,
				"goals_for": 0,
				"goals_against": 0,
				"goal_difference": 0,
				"points": 0
				}
			]
			}
		]
		}

		Rules:
		- Use ONLY data found in the tables
		- If the group stage has not started, return empty groups []
		- Do NOT add explanations
		- Do NOT use Markdown
		- Return RAW JSON only

		Wikipedia HTML/Text:
		${htmlText}
		`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    // Clean string just in case
    const jsonString = text.replace(/```json/g, "").replace(/```/g, "").trim();
	if (!jsonString.startsWith("{")) {
		throw new Error("Gemini returned invalid JSON");
	}
    const jsonData = JSON.parse(jsonString);

    console.log("Uploading to Firebase Storage...");
    const bucket = admin.storage().bucket();
    const file = bucket.file('afcon_standings.json');
    
    await file.save(JSON.stringify(jsonData, null, 2), {
      contentType: 'application/json',
      metadata: { cacheControl: 'public, max-age=300' }
    });

    console.log("Done! File updated.");

  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

run();