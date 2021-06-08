# Archive API

> 

## About

Archive API for [Twitch-Recorder-Go post-to-api branch](https://github.com/TimIsOverpowered/twitch-recorder-go/tree/post-to-api)

## Getting Started

Getting up and running is as easy as 1, 2, 3.

1. Make sure you have [NodeJS](https://nodejs.org/) and [npm](https://www.npmjs.com/) installed.
2. You must be using [Twitch-Recorder-Go post-to-api branch](https://github.com/TimIsOverpowered/twitch-recorder-go/tree/post-to-api)
3. Install your dependencies

    ```
    cd path/to/archive
    npm install
    install postgresql
    ```
    
4. Add tables using the src/services folder.
   For example: There is a logs service and a vods service. Add them both as a table in postgres.
   
5. Add the columns using the src/models folder.
    
6. Make the following configs using the templates found in the config folder.
   
   ```
   path/to/archive/config/config.json
   path/to/archive/config/default.json
   path/to/archive/config/production.json (used in nodejs production mode) (copy default.json)
   ```
  
7. Start your app

    ```
    npm start
    ```