const config = require("../../config/config.json");
const axios = require("axios");

module.exports.save = async (vodId, app) => {
  const BASE_FFZ_EMOTE_API = "https://api.frankerfacez.com/v1",
    BASE_BTTV_EMOTE_API = "https://api.betterttv.net/3",
    BASE_7TV_EMOTE_API = "https://api.7tv.app/v2";

  const twitchId = config.twitch.id;

  const FFZ_EMOTES = await axios(`${BASE_FFZ_EMOTE_API}/room/id/${twitchId}`, {
    method: "GET",
  })
    .then((response) => {
      const emotes = response.data.sets[response.data.room.set].emoticons;
      let newEmotes = [];
      for (let emote of emotes) {
        newEmotes.push({ id: emote.id, code: emote.name });
      }
      return newEmotes;
    })
    .catch(async (e) => {
      console.error(e.response ? e.response.data : e);
      return null;
    });

  let BTTV_EMOTES = await axios(`${BASE_BTTV_EMOTE_API}/cached/emotes/global`, {
    method: "GET",
  })
    .then((response) => {
      const emotes = response.data;
      let newEmotes = [];
      for (let emote of emotes) {
        newEmotes.push({ id: emote.id, code: emote.code });
      }
      return newEmotes;
    })
    .catch(async (e) => {
      console.error(e.response ? e.response.data : e);
      return null;
    });

  const BTTV_CHANNEL_EMOTES = await axios(
    `${BASE_BTTV_EMOTE_API}/cached/users/twitch/${twitchId}`,
    {
      method: "GET",
    }
  )
    .then((response) => {
      const emotes = response.data.channelEmotes.concat(
        response.data.sharedEmotes
      );
      let newEmotes = [];
      for (let emote of emotes) {
        newEmotes.push({ id: emote.id, code: emote.code });
      }
      return newEmotes;
    })
    .catch(async (e) => {
      console.error(e.response ? e.response.data : e);
      return null;
    });

  if (BTTV_CHANNEL_EMOTES)
    BTTV_EMOTES = BTTV_EMOTES.concat(BTTV_CHANNEL_EMOTES);

  const _7TV_EMOTES = await axios(
    `${BASE_7TV_EMOTE_API}/users/${config.twitch.username}/emotes`,
    {
      method: "GET",
    }
  )
    .then((response) => {
      const emotes = response.data;
      let newEmotes = [];
      for (let emote of emotes) {
        newEmotes.push({ id: emote.id, code: emote.name });
      }
      return newEmotes;
    })
    .catch(async (e) => {
      console.error(e.response ? e.response.data : e);
      return null;
    });

  const exists = await app
    .service("emotes")
    .get(vodId)
    .then(() => true)
    .catch(() => false);

  if (!exists)
    await app
      .service("emotes")
      .create({
        vodId: vodId,
        ffz_emotes: FFZ_EMOTES ? FFZ_EMOTES : [],
        bttv_emotes: BTTV_EMOTES ? BTTV_EMOTES : [],
        "7tv_emotes": _7TV_EMOTES ? _7TV_EMOTES : [],
      })
      .then(() => console.info(`Created ${vodId} emotes..`))
      .catch((e) => console.error(e));
  else
    await app
      .service("emotes")
      .patch(vodId, {
        ffz_emotes: FFZ_EMOTES ? FFZ_EMOTES : [],
        bttv_emotes: BTTV_EMOTES ? BTTV_EMOTES : [],
        "7tv_emotes": _7TV_EMOTES ? _7TV_EMOTES : [],
      })
      .then(() => console.info(`Patched ${vodId} emotes..`))
      .catch((e) => console.error(e));
};
