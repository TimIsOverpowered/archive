# Archives

> 

## About

Automated Upload Twitch Vod to Youtube after streaming 

## Getting Started

Getting up and running is as easy as 1, 2, 3.

1. Make sure you have [NodeJS](https://nodejs.org/) and [npm](https://www.npmjs.com/) installed.
2. Install your dependencies

    ```
    cd path/to/archive
    npm install
    install postgresql
    ```
    
3. Add tables using the src/services folder.
   For example: There is a logs service and a vods service. Add them both as a table in postgres.
   
4. Add the columns using the src/models folder.
    
4. Make the following configs using the templates found in the config folder.
   
   ```
   path/to/archive/config/config.json
   path/to/archive/config/default.json
   path/to/archive/config/production.json (used in nodejs production mode) (copy default.json)
   ```
  
5. Start your app

    ```
    npm start
    ```
## Verifying your Youtube channel

To upload 15 minutes+ videos, you will need to verify your youtube using this [link](https://www.youtube.com/verify)

## Verifying your Google Console API

To make your videos publicly automatically, you need to undergo an audit from google.

Please refer to https://developers.google.com/youtube/v3/docs/videos/insert
