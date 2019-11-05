const express = require('express')
const bodyParser = require('body-parser')
const session = require('express-session')
const passport = require('passport')
const TwitterStrategy = require('passport-twitter')
const uuid = require('uuid/v4')
const security = require('./helpers/security')
const auth = require('./helpers/auth')
const cacheRoute = require('./helpers/cache-route')
const socket = require('./helpers/socket')
const app = express()
var GoogleSpreadsheet = require('google-spreadsheet');

app.set('port', (process.env.PORT || 3000))
app.set('views', __dirname + '/views')
app.set('view engine', 'ejs')

app.use(express.static(__dirname + '/public'))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(passport.initialize());
app.use(session({
  secret: 'keyboard cat',
  resave: false,
  saveUninitialized: true
}))

var Twit = require('twit')

var T = new Twit({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token: process.env.TWITTER_ACCESS_TOKEN,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  timeout_ms: 60 * 1000,  // optional HTTP request timeout to apply to all requests.
  strictSSL: true,     // optional - requires SSL certificates to be valid.
})


// start server
const server = app.listen(app.get('port'), function () {
  console.log('Node app is running on port', app.get('port'))
})

// initialize socket.io
socket.init(server)

// form parser middleware
var parseForm = bodyParser.urlencoded({ extended: false })


/**
 * Receives challenge response check (CRC)
 **/
app.get('/webhook/twitter', function (request, response) {

  var crc_token = request.query.crc_token

  if (crc_token) {
    var hash = security.get_challenge_response(crc_token, auth.twitter_oauth.consumer_secret)

    response.status(200);
    response.send({
      response_token: 'sha256=' + hash
    })
  } else {
    response.status(400);
    response.send('Error: crc_token missing from request.')
  }
})


/**
 * Serves the home page
 **/
app.get('/', function (request, response) {
  response.render('index')
})


/**
 * Subscription management
 **/

auth.basic = auth.basic || ((req, res, next) => next())

app.get('/subscriptions', auth.basic, cacheRoute(1000), require('./routes/subscriptions'))


/**
 * Starts Twitter sign-in process for adding a user subscription
 **/
app.get('/subscriptions/add', passport.authenticate('twitter', {
  callbackURL: '/callbacks/addsub'
}));

/**
 * Starts Twitter sign-in process for removing a user subscription
 **/
app.get('/subscriptions/remove', passport.authenticate('twitter', {
  callbackURL: '/callbacks/removesub'
}));


/**
 * Webhook management routes
 **/
var webhook_view = require('./routes/webhook')
app.get('/webhook', auth.basic, auth.csrf, webhook_view.get_config)
app.post('/webhook/update', parseForm, auth.csrf, webhook_view.update_config)
app.post('/webhook/validate', parseForm, auth.csrf, webhook_view.validate_config)
app.post('/webhook/delete', parseForm, auth.csrf, webhook_view.delete_config)


/**
 * Activity view
 **/
app.get('/activity', auth.basic, require('./routes/activity'))


/**
 * Handles Twitter sign-in OAuth1.0a callbacks
 **/
app.get('/callbacks/:action', passport.authenticate('twitter', { failureRedirect: '/' }),
  require('./routes/sub-callbacks'))



/*
 Receives Account Acitivity events
 */
app.post('/webhook/twitter', function (request, response) {
  let data = request.body
  if (data["tweet_create_events"]) {
    if (data["tweet_create_events"][0]["retweeted_status"] != undefined) {
      parse_rt(data["tweet_create_events"][0])
    } 
  } else if (data["direct_message_events"]) {
    parse_dm(data)
  }

  socket.io.emit(socket.activity_event, {
    internal_id: uuid(),
    event: request.body
  })

  response.send('200 OK')
})
/*
Parse the DM event from twitter and see if it needs to be added to the sheet
*/
const parse_dm = (message) => {
  let text = message["direct_message_events"][0]["message_create"]["message_data"]["text"]
  let sender_id = message["direct_message_events"][0]["message_create"]["sender_id"]
  text = text.substring(0, 42)
  if (text.substring(0, 2) == "0x") {
    get_participants().then(function (people) {
      for (i in people) {
        if (people[i].address == text) {
          return console.log("Don't need to add")
        }
      }
      text = text.substring(0, 42)
      return update_sheet_with_address(text, sender_id, people)
    })
  }
}

/*
Parse a retweet event from twitter and see if they need to be added to the sheet
*/
const parse_rt = (data) => {
  let tweetid = data["retweeted_status"]["id_str"]
  let screen_name = data["user"]["screen_name"]
  console.log(tweetid)
  console.log(screen_name)
  get_retweets().then(function(retweets, err) {
    //tweet is in the sheet
    if (retweets[tweetid] != undefined) {
      if(retweets[tweetid][screen_name] != undefined) {
        if(retweets[tweetid][screen_name] == 'TRUE') {
          return
        }
      }
    }
    return update_retweet_sheet(tweetid,screen_name)
    
  })
}


/*
Locate the retweeter's screen name and decide if a row needs to be updated or added
Will edit/add an address on the sheet
*/
const update_sheet_with_address = (text, sender_id, people) => {
  //get their twitter handle 
  T.get('users/lookup', { user_id: sender_id, include_entities: false }, function (err, user) {
    screen_name = user[0].screen_name

    //go through all rows of spreadsheet and see if their handle is already there
    let i;
    for (i = 0; i < people.length; i++) {
      if (people[i].twitter == screen_name) {
        //found the user's data on the sheet, let's update it with their address
        console.log("Updating sheet at " + people[i].row_number)
        people[i].address = text
        return update_participants_sheet(people[i], false)
      }
    }
    let person = {
      address: text,
      twitter: screen_name,
      row_number: (i + 1)
    }
    update_participants_sheet(person, true)
  })
  return
}

/*
Pull the data from the participants spreadsheet
Returns an array of objects containg {address,name,twitter,email,row-number}
*/
function get_participants() {
  return new Promise(function (resolve, reject) {
    var creds = require('./crypto-201803-ea9734b5c249.json');
    var doc = new GoogleSpreadsheet('1d_UGlOztaekxexXWeZngXWNMoOHqu7A8EeIasIxoOlM');
    doc.useServiceAccountAuth(creds, function (err) {
      let people = []
      // Get all of the rows from the spreadsheet.
      doc.getRows(1, function (err, rows) {
        if (err) reject(err)
        for (i in rows) {
          if (rows[i].address.length > 0) {
            let person = {
              address: rows[i].address,
              name: rows[i].name,
              twitter: rows[i].twitter,
              email: rows[i].email,
              row_number: (parseInt(i))
            }
            people.push(person)
          }
        }
        resolve(people)
      });
    });
  })
}

var creds = require('./crypto-201803-ea9734b5c249.json');
var doc = new GoogleSpreadsheet('1d_UGlOztaekxexXWeZngXWNMoOHqu7A8EeIasIxoOlM');

/*
Pull the data from the retweets spreadsheet
Returns a dictionary of dictionaries such as:
dict[tweet_id] = {twitter_handle1: paid_out, twitter_handle2 : paid _out}
The keys in the inner dictionary are the users who retweeted this specific tweet and maps to if they've been paid out
*/
function get_retweets() {
  return new Promise(function (resolve, reject) {
    doc.useServiceAccountAuth(creds, function (err) {
      let tweets = {}
      // Get all of the rows from the spreadsheet.
      doc.getRows(2, function (err, rows) {
        if (err) reject(err)
        for (i in rows) {
          if (!tweets[rows[i].tweetid]) {
            tweets[rows[i].tweetid] = {}
          }
          tweets[rows[i].tweetid][rows[i].screenname] = rows[i].paid
        }
        resolve(tweets)
      });
    });
  })
}


/*
Update the particpants sheet with a twitter user's TBT address
new_row: true if need to add a row to the end of document, false if twitter handle is already there
person: data from DM to add to sheet
*/
const update_participants_sheet = (person, new_row) => {
  
  doc.useServiceAccountAuth(creds, function (err) {
    // Get all of the rows from the spreadsheet.
    if (!new_row) {
      doc.getRows(1, function (err, rows) {
        rows[person.row_number].address = person.address
        rows[person.row_number].save()
      });
    } else {
      doc.addRow(1, { twitter: person.twitter, address: person.address }, function (err, row) {
        return
      })
    }
  });
}

/*
Update the retweets sheet with a new row containing the twitter handle to pay out
tweetid: id of the retweeted tweet
screen_name: retweeters twitter handle
*/
const update_retweet_sheet = (tweetid, screen_name) => {
  var creds = require('./crypto-201803-ea9734b5c249.json');
  var doc = new GoogleSpreadsheet('1d_UGlOztaekxexXWeZngXWNMoOHqu7A8EeIasIxoOlM');
  doc.useServiceAccountAuth(creds, function (err) {
      doc.addRow(2, {tweetid: tweetid, screenname: screen_name, paid : 'FALSE'}, function (err, row) {
        return
      })
    })
}