require('dotenv').config()

const Web3 = require("web3")
const web3 = new Web3("https://bsc-dataseed.binance.org/");
const privateKey = process.env.LIMIT_ORDER_EXECUTOR_PRIVATE_KEY
const account = web3.eth.accounts.privateKeyToAccount('0x' + privateKey);
web3.eth.accounts.wallet.add(account);
web3.eth.defaultAccount = account.address;

const { tokenPricePool , limitOrderPool, stopLossPool } = require('./databaseClient');

const express = require('express')
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
const UtopiaLimitOrderRouterContract = require("../resources/UtopiaLimitOrderRouter.json");
const pancakeswapFactoryAbi = require("../resources/PancakeFactoryV2.json");

const pancakeswapFactoryV2 = new web3.eth.Contract(
  pancakeswapFactoryAbi,
  "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"
);


const UtopiaLimitOrderRouter = new web3.eth.Contract(
  UtopiaLimitOrderRouterContract.abi,
  UtopiaLimitOrderRouterContract.networks["56"].address
);

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
        console.log("order results")
        console.log(results)
        // Execute order 
        var pairContract = await this.getContractPair(pancakeswapFactoryV2, token, "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c")
        for (const order of results[0]) { 
          await UtopiaLimitOrderRouter.methods(order.ordererAddress, order.tokenIn, order.tokenOut, pairContract,order.amountIn, order.amountOut).makeBNBTokenSwap.send({
            from: web3.eth.defaultAccount
          })
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

getContractPair = async function (factory, address0, address1) {
  const pairAddress = await factory.methods
    .getPair(address0, address1)
    .call();

  const contract = new web3.eth.Contract(this.pancakeswapPairAbi, pairAddress);
  const token0 = await contract.methods.token0().call();
  contract.addressOrderReversed = token0.toLowerCase() !== address0.toLowerCase();
  return contract;
};