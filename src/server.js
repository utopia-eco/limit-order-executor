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
// const pancakeswapRouterV2Abi = require("../resources/PancakeRouterV2.json")

const pancakeswapFactoryV2 = new web3.eth.Contract(
  pancakeswapFactoryAbi,
  // "0xBCfCcbde45cE874adCB698cC183deBcF17952812"  // V1Router
  "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"
);

// const pancakeswapRouterV2 = new web3.eth.Contract(
//   pancakeswapFactoryAbi,
//   "0x10ED43C718714eb63d5aA57B78B54704E256024E"
// )


const UtopiaLimitOrderRouter = new web3.eth.Contract(
  UtopiaLimitOrderRouterContract.abi,
  UtopiaLimitOrderRouterContract.networks["56"].address
);

app.listen(port, async () => {
  console.log(`Listening at http://localhost:${port}`)

  const tokens = Tokens.TokenList;

  while (true) {
    // Loop through tokens that we are interested in
    for  (const retrievedToken of tokens) {
      token = retrievedToken.toLowerCase();
      console.log("Executing for token ", token)
      
      const latestPrice = await retrievePrice(token)

      await executeLimitOrders(token, latestPrice)
      await executeStopLosses(token, latestPrice)

      await new Promise(resolve => setTimeout(resolve, 2000));
    }  
  }
})

async function retrievePrice(token) {
  const query = "SELECT * FROM " + token + "_300 order by startTime desc limit 1"
    try {
      const [results, fields] = await tokenPricePool.query(query);
      if (!results[0]) {
        console.error("Price not found for ", token)
      } else {
        return results[0].close;
      }
    } catch (error) {
      console.error("error", error);
    }
}

async function executeLimitOrders(token, latestPrice) {
  const currentTime = Math.round(new Date() / 1000)
  const retryTime = currentTime - 300;
  
  const query = "SELECT * FROM " + token + "_limitOrder WHERE tokenPrice < " + 1 / latestPrice + " AND " + retryTime + " > lastAttemptedTime AND attempts < 5 AND (orderStatus = 'PENDING' OR orderStatus = 'ATTEMPTED') ";
  console.log(query)
    try {
      var [results, fields] = await limitOrderPool.query(query);
      // For testing
      // var results = [
      //   {
      //   ordererAddress: '0x431893403d0bd9fee90e5ed5a9ed1bc93be640e7',
      //   tokenInAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      //   tokenOutAddress: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
      //   tokenInAmount: 10000,
      //   tokenOutAmount: 5,
      //   tokenPrice: 0.0001,
      //   attempts: 0,
      //   orderCode: '6c041eaa-a0f4-4050-b584-261e560ccac8'
      // },
      // ]
      // var results = [
      //   {
      //   ordererAddress: '0x431893403d0bd9fee90e5ed5a9ed1bc93be640e7',
      //   tokenInAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      //   tokenOutAddress: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
      //   tokenInAmount: 1000000000000000,
      //   tokenOutAmount: 500000000000,
      //   tokenPrice: 0.0001,
      //   attempts: 0,
      //   orderCode: '6c041eaa-a0f4-4050-b584-261e560ccac8'
      // },
      // ]
      if (!results[0]) {
        // No limit orders found for change in price
        return;
      } else {
        // Execute order 
        const gasPrice = await web3.eth.getGasPrice();
        for (const order of results) { 
          var updateQuery;
          
          try {       
            console.log(currentTime)
            const gasEstimate = await UtopiaLimitOrderRouter.methods
              .makeBNBTokenSwap(order.ordererAddress, order.tokenInAddress, order.tokenOutAddress, order.tokenInAmount.toString(), order.tokenOutAmount.toString(), currentTime + 300)
              .estimateGas({ from: web3.eth.defaultAccount });

            const res = await UtopiaLimitOrderRouter.methods.makeBNBTokenSwap(order.ordererAddress, order.tokenInAddress, order.tokenOutAddress, order.tokenInAmount.toString(), order.tokenOutAmount.toString(), currentTime + 300).send({
                  from: web3.eth.defaultAccount,
                  gasPrice: gasPrice, 
                  gas: gasEstimate * 1.5,
                })
            
            if (res.status == true) {
              updateQuery = "UPDATE " + order.tokenOutAddress.toLowerCase() + "_limitOrder SET attempts = " + (order.attempts + 1) + ", orderStatus = 'COMPLETED', executionTxHash = '" + res.transactionHash.toLowerCase() + "' WHERE orderCode = '" + order.orderCode + "'";
              console.log("Order has been successfully executed ", res.transactionHash)
              // Send BNB to owner address
            } else {
              if (order.attempts >= 4) {
                updateQuery = "UPDATE " + order.tokenOutAddress.toLowerCase() + "_limitOrder SET attempts = " + (order.attempts + 1) + ", orderStatus = 'FAILED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode  + "'";
              } else if (order.attempts == 0) {
                updateQuery = "UPDATE " + order.tokenOutAddress.toLowerCase() + "_limitOrder SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode  + "'";
              }
            }
          } catch (err) {
            console.error("Error executing transaction", err);
            updateQuery = "UPDATE " + order.tokenOutAddress.toLowerCase() + "_limitOrder SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode  + "'";
          }
          // Update limit order details
          console.log("Update order query ", updateQuery)
          try {
            await limitOrderPool.query(updateQuery).catch((error) => {
                console.error("Execution of query to update limit order failed", error)
            })
          } catch (err) {
            console.error("Creation of connection to update limit order failed", err)
          }
        }
      }
    } catch (error) {
      console.error("error", error);
    }
}

async function executeStopLosses(token, latestPrice) {
  return;
}

getPairAddress = async function (factory, address0, address1) {
  const pairAddress = await factory.methods
    .getPair(address0, address1)
    .call();

  return pairAddress;
};