// Vercel serverless function — equivalent of the old netlify/functions/gemini-proxy.js
// Vercel auto-detects any file in /api as a serverless function; this one
// is reachable at /api/gemini-proxy (matches the fetch() call in app.js).
//
// Set GEMINI_API_KEY as an Environment Variable in your Vercel project
// settings (Project → Settings → Environment Variables) — same idea as
// Netlify's env vars, just a different dashboard.

export default async function handler(req, res) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        return res.status(200).end();
    }

    try {
        const apiKey = process.env.GEMINI_API_KEY;
        const body = req.body; // Vercel parses JSON bodies automatically

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(response.status).json(data);

    } catch (err) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(500).json({ error: err.message });
    }
}
