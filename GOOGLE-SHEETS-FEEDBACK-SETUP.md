# TrivexaAI Google Sheets Feedback Setup

This connects the feedback form on your website to a private Google Sheet. Visitors do not open Google Forms and do not need a Google account.

## 1. Create your private sheet
1. Open https://sheets.google.com while signed in to the Google account where you want to receive feedback.
2. Create a **Blank spreadsheet**.
3. Name it **TrivexaAI Feedback**.
4. Keep its sharing setting private (Restricted). Do not publish the sheet or share it with visitors.

## 2. Add the receiver script
1. In the sheet, click **Extensions → Apps Script**.
2. In the Apps Script editor, open `Code.gs`, remove its starter code, and paste the complete code from this repository file: `google-apps-script/Code.gs`.
3. Click **Save**.

## 3. Deploy the web app
1. Click **Deploy → New deployment**.
2. Click the gear icon and choose **Web app**.
3. Set **Execute as** to **Me**.
4. Set **Who has access** to **Anyone** (not anyone with the sheet link; the sheet itself remains Restricted).
5. Click **Deploy** and complete Google's authorization prompts.
6. Copy the Web app URL. It should end in `/exec`. Do not share your sheet's private URL.

## 4. Connect the website
The website file `feedback.html` contains this setting near the bottom:
`const GOOGLE_SHEETS_ENDPOINT = "PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE";`

Replace only the placeholder text with your Web app URL, keeping the quotation marks. Save/commit the file to GitHub. Once connected, test one feedback submission and confirm it appears in the sheet's **Feedback** tab.

## What gets saved
Timestamp, star rating, feedback category, message, and page source. The form does not ask visitors for their name or email. Keep the spreadsheet private.

## Important
If you edit the Apps Script after deploying, open **Deploy → Manage deployments → Edit** and deploy a new version so the live web app uses the updated code.
