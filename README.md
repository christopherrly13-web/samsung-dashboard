# Samsung Search Bi-weekly Dashboard

A locally-hosted Google Ads dashboard for Samsung's MX, HE, EBD, DA, and EPP divisions.

---

## Prerequisites

- **Node.js** v18 or higher → https://nodejs.org
- A Google Ads **Developer Token** (Standard or Basic access)
- OAuth2 credentials (**Client ID**, **Client Secret**, **Refresh Token**)
- Your **Manager Account (MCC) ID** and each division's **Customer Account ID**

---

## Setup

### 1. Install dependencies
```bash
cd samsung-dashboard
npm install
```

### 2. Configure credentials
Copy the example env file and fill in your values:
```bash
cp .env.example .env
```

Open `.env` and fill in:
```
GOOGLE_ADS_DEVELOPER_TOKEN=   # From Google Ads → Tools → API Center
GOOGLE_ADS_CLIENT_ID=         # From Google Cloud Console → OAuth2 credentials
GOOGLE_ADS_CLIENT_SECRET=     # From Google Cloud Console → OAuth2 credentials
GOOGLE_ADS_REFRESH_TOKEN=     # See "Getting a Refresh Token" below
GOOGLE_ADS_MCC_ID=            # Your Manager Account ID (e.g. 123-456-7890)

ACCOUNT_ID_MX=                # MX division account ID
ACCOUNT_ID_HE=                # HE division account ID
ACCOUNT_ID_EBD=               # EBD division account ID
ACCOUNT_ID_DA=                # DA division account ID
ACCOUNT_ID_EPP=               # EPP division account ID
```

### 3. Start the server
```bash
npm start
```

Then open your browser to: **http://localhost:3000**

---

## Getting a Refresh Token

If you only have an access token, you'll need to exchange it for a refresh token.
Run this once to get your refresh token:

```bash
node -e "
const { GoogleAdsApi } = require('google-ads-api');
require('dotenv').config();
const client = new GoogleAdsApi({
  client_id: process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});
// Visit this URL in your browser, approve, and paste the code below
const authUrl = client.generateAuthenticationUrl();
console.log('Visit this URL:', authUrl);
"
```

Then paste the authorization code here to get your refresh token:
```bash
node -e "
const { GoogleAdsApi } = require('google-ads-api');
require('dotenv').config();
const client = new GoogleAdsApi({
  client_id: process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});
client.createAuthenticationUrl();  // then:
client.getToken('PASTE_AUTH_CODE_HERE').then(t => console.log('Refresh token:', t.refresh_token));
"
```

---

## Campaign Type Detection

The server detects campaign types by matching campaign names against these patterns:

| Type     | Pattern (regex)            |
|----------|---------------------------|
| Text     | `/text\|search/i`          |
| Shopping | `/shopping/i`              |
| Pmax     | `/pmax\|performance.max/i` |
| Shop App | `/shop.?app/i`             |

Edit `server/index.js` → `CAMPAIGN_TYPE_PATTERNS` to match your actual campaign naming conventions.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/report?startDate=&endDate=&prevStartDate=&prevEndDate=` | Fetch bi-weekly report data |
| `GET /api/accounts` | Verify connectivity to all configured accounts |

---

## Development

For auto-reload during development:
```bash
npm run dev
```

---

## Project Structure

```
samsung-dashboard/
├── .env.example        ← Copy to .env and fill in credentials
├── package.json
├── server/
│   └── index.js        ← Express API server + Google Ads queries
└── public/
    └── index.html      ← Full dashboard frontend
```
