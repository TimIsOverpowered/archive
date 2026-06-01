# Privacy Policy

**Last updated: June 1, 2026**

## Overview

This project ("archive") is a self-hosted tool that automatically uploads Twitch/KICK VODs to a YouTube channel after a stream ends.

---

## YouTube API Services

This application uses the [YouTube API Services](https://developers.google.com/youtube/terms/api-services-terms-of-service) to upload videos to a YouTube channel

By using YouTube API Services, this application is subject to the [Google Privacy Policy](https://policies.google.com/privacy).

---

## Data Collected

This application collects and stores the following data solely to perform its function:

- **YouTube OAuth tokens** — Used to authenticate with the YouTube API and upload videos. Stored locally in a PostgreSQL database on the operator's own server.
- **Twitch VOD metadata** — Video titles, descriptions, and timestamps used to populate YouTube upload details. Stored locally for upload logging purposes.
- **Kick VOD metadata** — Video titles, descriptions, and timestamps used to populate YouTube upload details. Stored locally for upload logging purposes.
- **Upload logs** — Records of upload activity (video ID, timestamp, status) stored locally for debugging.

---

## How Data Is Used

All collected data is used exclusively to:

- Authenticate with Google/YouTube on behalf of the channel owner
- Upload Twitch VODs to the user's own YouTube channel
- Upload KICK VODs to the user's own YouTube channel
- Log upload activity for personal debugging and record-keeping

**No data is sold, shared, or transmitted to any third party.**

---

## Data Storage & Security

All data (OAuth tokens, logs, VOD metadata) is stored on the operator's own self-hosted server. No data is stored in third-party cloud services beyond what is necessary for the YouTube API OAuth flow (handled by Google).

---

## Data Deletion

You may revoke this application's access to your YouTube account at any time by visiting:

**[https://myaccount.google.com/permissions](https://myaccount.google.com/permissions)**

Find the application and click "Remove Access." This will invalidate all stored OAuth tokens. Any locally stored tokens can then be deleted directly from the PostgreSQL database.

---

## Children's Privacy

This tool is not directed at children and does not knowingly collect any information from individuals under the age of 13.

---

## Changes to This Policy

This privacy policy may be updated occasionally. Updates will be reflected by a new "Last updated" date at the top of this file.

---

## Contact

For any questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/TimIsOverpowered/archive).
