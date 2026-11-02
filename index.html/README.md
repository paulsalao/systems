# Whispering Pines booking app

The site now uses an Express API and SQLite database for shared booking availability and admin records. Run it through the Node server; opening the HTML files directly with `file://` will not connect to the API.

## Run locally

1. Install Node.js 20 or newer.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` with `Copy-Item .env.example .env`.
4. Set `ADMIN_PASSWORD` to a unique password of at least 12 characters. Set `SESSION_SECRET` to a random value of at least 32 characters. To generate a secret, run:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

5. Run `npm start` and open `http://localhost:3000`.

The database is created at `data/bookings.sqlite`. The default blocked time ranges from the original booking page are seeded for each new date. Admin login is protected by a server-side password check, rate limiting, and an HTTP-only session stored in SQLite.

## Deploy online

`render.yaml` configures a Node web service with a persistent disk mounted at `/var/data`, so SQLite data survives service restarts and deployments. Put the project files in a Git repository, connect that repository to Render, and deploy the blueprint. Set `ADMIN_PASSWORD` in the Render dashboard to a unique password; Render generates `SESSION_SECRET`. The persistent disk requires a Render plan that supports disks.

For another hosting provider, configure the start command as `npm start`, set `NODE_ENV=production`, `ADMIN_PASSWORD`, and a random `SESSION_SECRET`, and point `DB_PATH` to durable persistent storage. Do not deploy SQLite on an ephemeral filesystem: bookings would be lost when the service restarts.

The app serves both the web pages and API from the same origin. Use HTTPS in production; production session cookies are marked secure.
