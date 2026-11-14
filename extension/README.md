# extension frontend

A Chrome extension (Manifest V3). Select text on any page, right-click, and choose **Fact-check selection**. The text is sent to the backend and the answer is shown in the side panel.

## Files

- `manifest.json`: extension config and permissions.
- `background.js`: adds the right-click menu item and sends `POST /api/factcheck/` to the backend.
- `sidepanel.html` / `sidepanel.js`: shows the result and the settings (backend URL and password).

## Load it

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `extension/` folder.
3. Click the extension's toolbar icon to open the side panel. Enter the backend URL (default `http://localhost:8000`) and the password, then click **Log in**.
4. Select some text, right-click it and choose **Fact-check selection**.

After you edit the code, click the reload icon on the extension's card in `chrome://extensions`.

## Password

Every request is a JSON body `{"text": "...", "password": "..."}`. The backend rejects a wrong or missing password with HTTP 401. The backend stores only a hash of the password (`FACTCHECK_PASSWORD_HASH`, see `backend/.env.example`).

You enter the password once. It is saved in `chrome.storage.local`, which only this extension can read (web pages can't, unlike cookies or `localStorage`). It stays saved after a browser restart until you click **Log out**, or until the backend answers 401, which deletes it and shows the login form again.

The extension refuses to send the password to an `http://` URL unless the host is `localhost` or `127.0.0.1`, so the deployed backend must use **https://**.
