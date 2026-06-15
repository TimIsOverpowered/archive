# Privacy Policy

**Last updated: June 15, 2026**

## Overview

This project ("archive") is a multi-platform VOD archiving and upload service for commercial use. The platform automatically archives live stream VODs from streaming platforms — including Twitch and KICK — and uploads them to YouTube channels on behalf of content creators. It includes a frontend web application at [overpowered.tv](https://overpowered.tv) for viewers to watch archived VODs with chat replay.

---

## YouTube API Services

This application uses the [YouTube API Services](https://developers.google.com/youtube/terms/api-services-terms-of-service) to upload videos to YouTube channels on behalf of connected content creators.

By using YouTube API Services, this application is subject to the [Google Privacy Policy](https://policies.google.com/privacy).

---

## Cookies and Tracking Technologies

**This platform does not use cookies, tracking pixels, or any third-party tracking technology.**

The frontend web application uses **browser localStorage** exclusively to save viewer preferences locally on the viewer's own device. No data from localStorage is transmitted to our servers or any third party. The following items are stored:

- **`lastPlayed`** — The resume position (timestamp) for VODs the viewer has watched, stored locally so playback can resume where the viewer left off. Keyed per creator and VOD ID.
- **`player-settings`** — The viewer's player preferences, specifically volume level and muted state.
- **`chat-settings`** — The viewer's chat preferences, including chat panel width, chat side (left/right), timestamp visibility, font family, font size, and any personal word filters the viewer has set.

This data never leaves the viewer's browser and is not accessible to us. Viewers can clear this data at any time by clearing their browser's site data for this domain.

The backend service does not interact with browser storage in any way.

---

## Data Collected by the Backend

The backend service collects and stores the following data solely to perform its function:

- **YouTube OAuth tokens** — Used to authenticate with the YouTube API and upload videos on behalf of each connected creator. Stored in a PostgreSQL database on the operator's server.
- **Stream VOD metadata** — Video titles, descriptions, and timestamps sourced from Twitch or KICK, used to populate YouTube upload details. Stored for upload logging purposes.
- **Upload logs** — Records of upload activity (video ID, timestamp, status) stored for operational logging.

---

## How Data Is Used

All collected data is used exclusively to:

- Authenticate with Google/YouTube on behalf of connected content creators
- Upload Twitch and KICK VODs to each creator's own YouTube channel
- Log upload activity for operational record-keeping

**No data is sold, shared, or transmitted to any third party.**

---

## Data Retention and Deletion

YouTube API data (video IDs, upload metadata, and OAuth tokens) is written to our database at the time of upload and is not periodically re-fetched or refreshed from the YouTube API after the initial upload.

Stored YouTube API data is retained until a content creator explicitly requests deletion. Upon request, all associated YouTube data — including video IDs, metadata, and OAuth tokens — is permanently deleted from our database. We do not retain this data after a deletion request is fulfilled.

Content creators may also revoke this application's access to their YouTube account at any time by visiting:

**[https://myaccount.google.com/permissions](https://myaccount.google.com/permissions)**

Find the application and click "Remove Access." This will immediately invalidate all stored OAuth tokens.

---

## Data Protection and Security

We take the security of Google user data seriously and have implemented the following safeguards:

- **Encryption in transit:** All communication with the YouTube Data API and Google OAuth endpoints occurs exclusively over HTTPS/TLS.
- **Encryption at rest:** OAuth access tokens and refresh tokens are encrypted before being stored in our PostgreSQL database.
- **Access controls:** Access to the production database and stored credentials is restricted to the application's backend service and authorized administrators only. No third party has access to this data.
- **Minimal data retention:** We only store the data necessary to perform uploads on behalf of each creator (see "Data Retention and Deletion" above), and tokens are deleted immediately upon a creator's revocation or deletion request.
- **Secure infrastructure:** The application and database are hosted on infrastructure with standard security hardening, including firewall rules limiting access to required services only.

These measures are designed to protect the confidentiality, integrity, and availability of Google user data accessed through the YouTube API Services.

---

## Children's Privacy

This platform is not directed at children and does not knowingly collect any information from individuals under the age of 13.

---

## Changes to This Policy

This privacy policy may be updated occasionally. Updates will be reflected by a new "Last updated" date at the top of this file.

---

## Contact

For any questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/TimIsOverpowered/archive).
