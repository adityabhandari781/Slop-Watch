# Firebase Setup — Slop Watch

## 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **Add project** → name it (e.g. `slop-watch`) → Create
3. Skip Google Analytics if prompted

## 2. Create a Realtime Database

1. In the sidebar: **Build → Realtime Database**
2. Click **Create Database**
3. Choose a region close to you
4. Start in **Test mode** (we'll set rules below)

## 3. Set Security Rules

Go to the **Rules** tab and paste:

```json
{
  "rules": {
    "votes": {
      "$type": {
        "$entityId": {
          "$uuid": {
            ".read": true,
            ".write": true,
            ".validate": "newData.hasChild('vote') && (newData.child('vote').val() === 'ai' || newData.child('vote').val() === 'human')"
          }
        }
      }
    },
    "aggregates": {
      ".read": true,
      "$type": {
        "$entityId": {
          ".write": true,
          ".validate": "newData.hasChild('ai') && newData.hasChild('total') && newData.child('ai').isNumber() && newData.child('total').isNumber()"
        }
      }
    }
  }
}
```

Click **Publish**.

## 4. Configure the Extension

1. Copy your **Database URL** from the Realtime Database page (looks like `https://slop-watch-xxxxx-default-rtdb.firebaseio.com`)
2. Open `background.js`, replace line 12:
   ```js
   const FIREBASE_DB_URL = "https://YOUR_PROJECT_ID.firebaseio.com";
   ```
   with your actual URL (no trailing slash)
3. Open `manifest.json`, update the `host_permissions` to include your Firebase URL:
   ```json
   "host_permissions": [
     "*://*.youtube.com/*",
     "https://slop-watch-xxxxx-default-rtdb.firebaseio.com/*"
   ]
   ```

## 5. Load the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `Slop Watch` folder
4. Navigate to YouTube and test!
