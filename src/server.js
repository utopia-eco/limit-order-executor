require('dotenv').config()

const express = require('express')
const Web3 = require("web3")
const web3 = new Web3("https://bsc-dataseed.binance.org/");
const { tokenPricePool , limitOrderPool, stopLossPool } = require('./databaseClient');
const app = express()
const cors = require('cors')
const port = process.env.PORT

app.use(cors());
app.options('*', cors())

app.get('/', (req, res) => {
  res.send('Utopia Dex Limit Order Executor')
})

app.get('/health', (req, res) => res.send("Healthy"));

const Tokens = require("./tokens.js")
app.listen(port, async () => {
  console.log(`Listening at http://localhost:${port}`)

  const tokens = Tokens.TokenList;
  var tokenPrevPrice = new Map();

  while (true) {
    // Loop through tokens that we are interested in
    for  (const retrievedToken of tokens) {
      token = retrievedToken.toLowerCase();
      const latestPrice = await retrievePrice(token)
      
      // This block should only be run on service initialization
      if (tokenPrevPrice[token] == undefined) {
        tokenPrevPrice[token] = latestPrice;
        continue;
      } else if (latestPrice > tokenPrevPrice[token]) {
        // Execute potential limit orders since price has increased
        executeLimitOrders(token, latestPrice)
      } else if (latestPrice < tokenPrevPrice[token]) {
        // Execute potential stop losses since price has decreased
        executeStopLosses(token, latestPrice)
      }

      tokenPrevPrice[token] = latestPrice;      
    }  
  }
})

async function retrievePrice(token) {
  const query = "SELECT * FROM " + token + "_300 order by startTime desc limit 1"
    try {
      const [results, fields] = await tokenPricePool.query(query);
      if (!results[0]) {
        res.json({ status: "Not Found" });
      } else {
        res.json(results[0].close)
      }
    } catch (error) {
      console.error("error", error);
    }
}

async function executeLimitOrders(token, latestPrice) {
  const currentTime = Math.round(new Date() / 1000)
  const retryTime = currentTime - 300;
  const query = "SELECT * FROM " + token + "_limitOrder WHERE tokenPrice < " + latestPrice + " AND " + retryTime + " > lastAttemptedTime AND attempts < 5";
    try {
      const [results, fields] = await limitOrderPool.query(query);
      if (!results[0]) {
        // No limit orders found for change in price
        return;
      } else {
        // Execute order 
        for (const order of results[0]) {
          // Interact with smart contract  
          const res = 0;
          var updateQuery;
          if (res == true) {
            updateQuery = "UPDATE token SET attempts = " + (order.attempts + 1) + ", orderStatus = 'COMPLETED' WHERE orderCode = " + order.orderCode;
          } else {
            if (order.attempts >= 4) {
              updateQuery = "UPDATE token SET attempts = " + (order.attempts + 1) + ", orderStatus = 'FAILED' WHERE orderCode = " + order.orderCode;
            } else if (order.attempts == 0) {
              updateQuery = "UPDATE token SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED' WHERE orderCode = " + order.orderCode;
            }
          }
        }
      }
      try {
        await limitOrderPool.query(updateQuery).catch((error) => {
            console.error("Execution of query to update limit order failed", data, error)
        })
      } catch (err) {
        console.error("Creation of connection to update limit order failed")
      }
    } catch (error) {
      console.error("error", error);
    }
}

async function executeStopLosses(token, latestPrice) {
  return;
}