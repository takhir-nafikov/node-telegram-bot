const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const geolib = require('geolib');
const _ = require('lodash');
const config = require('./config');
const helper = require('./helper');
const keyboard = require('./keyboard');
const kb = require('./keyboard-buttons');
// const database = require('./database.json');

helper.logStart();

mongoose.connect(config.DB_URL, {useMongoClient: true})
    .then(() => console.log('MongoDB connected'))
    .catch((err) => console.log(err));
mongoose.Promise = require('bluebird');

require('./models/film.model');
require('./models/cinema.model');
require('./models/user.model');

const Film = mongoose.model('films');
const Cinema = mongoose.model('cinemas');
const User = mongoose.model('users');

// database.films.forEach((f) => new Film(f).save().catch((e) => console.log(e)));
// database.cinemas.forEach((c) => new Cinema(c).save().catch((e) => console.log(e)));

const ACTION_TYPE = {
    TOGGLE_FAV_FILM: 'ttf',
    SHOW_CINEMAS: 'sc',
    SHOW_CINEMAS_MAP: 'scm',
    SHOW_FILMS: 'sf',
};

const bot = new TelegramBot(config.TOKEN, {
  polling: true,
});

bot.on('message', (msg) => {
    console.log('Working', msg.from.first_name);

    const chatId = helper.getChatId(msg);

    switch (msg.text) {
        case kb.home.favourite:
            showFavoriteFilms(chatId, msg.from.id);
            break;
        case kb.home.films:
            bot.sendMessage(chatId, `Выберите жанр:`, {
                reply_markup: {keyboard: keyboard.films},
            });
            break;
        case kb.film.comedy:
            sendFilmsByQuery(chatId, {type: 'comedy'});
            break;
        case kb.film.action:
            sendFilmsByQuery(chatId, {type: 'action'});
            break;
        case kb.film.random:
            sendFilmsByQuery(chatId, {});
            break;
        case kb.home.cinemas:
            bot.sendMessage(chatId, 'Отправить местоположение', {
                reply_markup: {
                  keyboard: keyboard.cinemas,
                },
            });
            break;
        case kb.back:
            bot.sendMessage(chatId, `Что хотите посмотреть?`, {
                reply_markup: {keyboard: keyboard.home},
            });
            break;
    }

    if (msg.location) {
        getCinemaInCoord(chatId, msg.location);
    }
});

bot.on('callback_query', (query) => {
    const userId = query.from.id;
    let data;
    try {
        data = JSON.parse(query.data);
    } catch (e) {
        throw new Error('Data is not an object');
    }

    const {type} = data;

    if (type === ACTION_TYPE.SHOW_CINEMAS_MAP) {
        const {lat, lon} = data;
        bot.sendLocation(query.message.chat.id, lat, lon);
    } else if (type === ACTION_TYPE.SHOW_CINEMAS) {
        sendCinemasByQuery(userId, {uuid: {'$in': data.cinemaUuids}});
    } else if (type === ACTION_TYPE.TOGGLE_FAV_FILM) {
        toggleFavoriteFilm(userId, query.id, data);
    } else if (type === ACTION_TYPE.SHOW_FILMS) {
        sendFilmsByQuery(userId, {uuid: {'$in': data.filmUuids}});
    }
});

bot.on('inline_query', async (query) => {
    const films = Film.find({});
    const results = films.map((f) => {
        const caption = `Название: ${f.name}\nГод: ${f.year}\nРейтинг: ${f.rate}\nДлительность: ${f.length}\nСтрана: ${f.country}`;
        return {
            id: f.uuid,
            type: 'photo',
            photo_url: f.picture,
            thumb_url: f.picture,
            caption: caption,
            reply_markup: {
              inline_keyboard: [
                [
                    {
                        text: `Кинопоиск: ${f.name}`,
                        url: f.link,
                    },
                ],
              ],
            },
        };
    });

    bot.answerInlineQuery(query.id, results, {
        cache_time: 0,
    });
});

bot.onText(/\/start/, (msg) => {
    const text = `Здравствуйте, ${msg.from.first_name}\nВыберите команду для начала работы:`;
    bot.sendMessage(helper.getChatId(msg), text, {
        reply_markup: {
            keyboard: keyboard.home,
        },
    });
});

bot.onText(/\/f(.+)/, async (msg, [source, match]) => {
    const filmUuid = helper.getItemUuid(source);
    const chatId = helper.getChatId(msg);

    try {
        const film = await Film.findOne({uuid: filmUuid});
        const user = await User.findOne({telegramId: msg.from.id});

        let isFav = false;

        if (user) {
            isFav = user.films.indexOf(film.uuid) !== -1;
        }

        const favText = isFav ? 'Удалить из избранного' : 'Добавить в избранное';

        const caption = `Название: ${film.name}\nГод: ${film.year}\nРейтинг: ${film.rate}\nДлительность: ${film.length}\nСтрана: ${film.country}`;

        bot.sendPhoto(chatId, film.picture, {
            caption: caption,
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: favText,
                            callback_data: JSON.stringify({
                                type: ACTION_TYPE.TOGGLE_FAV_FILM,
                                filmUuid: film.uuid,
                                isFav: isFav,
                            }),
                        },
                        {
                            text: 'Показать кинотеатры',
                            callback_data: JSON.stringify({
                                type: ACTION_TYPE.SHOW_CINEMAS,
                                cinemaUuids: film.cinemas,
                            }),
                        },
                    ],
                    [
                        {
                            text: `Кинопоиск ${film.name}`,
                            url: film.link,
                        },
                    ],
                ],
            },
        });
    } catch (err) {
        console.log(err);
    }
});

bot.onText(/\/c(.+)/, async (msg, [source, match]) => {
    const cinemaUuid = helper.getItemUuid(source);
    const chatId = helper.getChatId(msg);

    const cinema = await Cinema.findOne({uuid: cinemaUuid});

    bot.sendMessage(chatId, `Кинотеатр ${cinema.name}`, {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: cinema.name,
                        url: cinema.url,
                    },
                    {
                        text: 'Показать на карте',
                        callback_data: JSON.stringify({
                            type: ACTION_TYPE.SHOW_CINEMAS_MAP,
                            lat: cinema.location.latitude,
                            lon: cinema.location.longitude,
                        }),
                    },
                ],
                [
                    {
                        text: 'Показать фильмы',
                        callback_data: JSON.stringify({
                            type: ACTION_TYPE.SHOW_FILMS,
                            filmUuids: cinema.films,
                        }),
                    },
                ],
            ],
        },
    });
});

// ================Functions================

/**
 * @param {*} chatId
 * @param {*} query
 */
async function sendFilmsByQuery(chatId, query) {
    const films = await Film.find(query);
    const html = films.map((f, i) => {
        return `<b>${i + 1}</b> ${f.name} - /f${f.uuid}`;
    }).join('\n');

    sendHTML(chatId, html, 'films');
};

/**
 * @param {*} chatId
 * @param {*} html
 * @param {*} kbName
 */
function sendHTML(chatId, html, kbName = null) {
    const options = {
        parse_mode: 'HTML',
    };

    if (kbName) {
        options['reply_markup'] = {
            keyboard: keyboard[kbName],
        };
    }

    bot.sendMessage(chatId, html, options);
};

/**
 * @param {*} chatId
 * @param {*} location
 */
async function getCinemaInCoord(chatId, location) {
    const cinemas = Cinema.find({});
    cinemas.forEach((c) => {
        c.distance = geolib.getDistance(location, c.location) / 1000;
    });
    cinemas = _.sortBy(cinemas, 'distance');

    const html = cinemas.map((c, i) => {
        return `<b>${i + 1}</b> ${c.name}. <em>Расстояние</em> - <strong>${c.distance}</strong> км. /c${c.uuid}`;
    }).join('\n');

    sendHTML(chatId, html, 'home');
};

/**
 * @param {*} userId
 * @param {*} queryId
 * @param {*} param2
 */
async function toggleFavoriteFilm(userId, queryId, {filmUuid, isFav}) {
    try {
        let userPromise;

        const user = await User.findOne({telegramId: userId});
        console.log(user._id);

        if (user) {
            if (isFav) {
                user.films = user.films.filter((fUuid) => fUuid !== filmUuid);
            } else {
                user.films.push(filmUuid);
            }
            userPromise = user;
        } else {
            userPromise = new User({
                telegramId: userId,
                films: [filmUuid],
            });
        }

        const answerText = isFav ? 'Удалено' : 'Добавлено';

        await userPromise.save();

        bot.answerCallbackQuery({
            callback_quety_id: queryId,
            text: answerText,
        });
    } catch (err) {
        console.log(err);
    }
};

/**
 * @param {*} chatId
 * @param {*} telegramId
 */
async function showFavoriteFilms(chatId, telegramId) {
    try {
        const user = User.findOne({telegramId});
        if (user) {
            const films = Film.find({uuid: {'$in': user.films}});
            let html;
            if (films.length) {
                html = films.map((f, i) => {
                    return `<b>${i + 1}</b> ${f.name} - <b>${f.rate}</b> (/f${f.uuid})`;
                }).join('\n');
            } else {
                html = 'Вы пока ничего не добавили';
            }
            sendHTML(chatId, html, 'home');
        } else {
            sendHTML(chatId, 'Вы пока ничего не добавили', 'home');
        }
    } catch (err) {
        console.log(err);
    }
};

/**
 * @param {*} userId
 * @param {*} query
 */
async function sendCinemasByQuery(userId, query) {
    const cinemas = await Cinema.find(query);

    const html = cinemas.map((c, i) => {
        return `<b>${i + 1}</b> ${c.name} - /c${c.uuid}`;
    }).join('\n');

    sendHTML(userId, html, 'home');
};
