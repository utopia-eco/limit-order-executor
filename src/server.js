require('dotenv').config()

const Web3 = require("web3")
const web3 = new Web3("https://bsc-dataseed.binance.org/");
const axios = require('axios');
const privateKey = process.env.LIMIT_ORDER_EXECUTOR_PRIVATE_KEY
const account = web3.eth.accounts.privateKeyToAccount('0x' + privateKey);
web3.eth.accounts.wallet.add(account);
web3.eth.defaultAccount = account.address;

const { tokenPricePool, limitBuyPool, limitSellPool, stopLossPool } = require('./databaseClient');

const express = require('express')
const app = express()
const cors = require('cors')
const port = process.env.PORT

app.use(cors());
app.options('*', cors())

app.get('/', (req, res) => {
  res.send('Utopia Dex Limit Order Executor v1')
})

app.get('/health', (req, res) => res.send("Healthy"));

const Tokens = require("./tokens.js")
const UtopiaLimitBuyRouterContract = require("../resources/UtopiaLimitOrderRouter.json");
const UtopiaStopLossRouterContract = require("../resources/UtopiaStopLossRouter.json");
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


const UtopiaLimitBuyRouter = new web3.eth.Contract(
  UtopiaLimitBuyRouterContract.abi,
  UtopiaLimitBuyRouterContract.networks["56"].address
);

const UtopiaStopLossRouter = new web3.eth.Contract(
  UtopiaStopLossRouterContract.abi,
  UtopiaStopLossRouterContract.networks["56"].address
);


app.listen(port, async () => {
  console.log(`Listening at http://localhost:${port}`)

  while (true) {
    await executeLimitBuyOrders()
    await executeLimitSellOrders()
    await executeStopLossOrders()

    await new Promise(resolve => setTimeout(resolve, 1000));
    
  }
})

async function retrievePrice(token) {
  try {
    const response = await axios.post(
      'https://graphql.bitquery.io',
        {
            query: `{
              ethereum(network: bsc) {
                dexTrades(
                  quoteCurrency: {is: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"}
                  baseCurrency: {is: "${token}"}
                  options: {desc: ["block.height", "transaction.index"], limit: 1}
                ) {
                  block {
                    height
                    timestamp {
                      time(format: "%Y-%m-%d %H:%M:%S")
                    }
                  }
                  transaction {
                    index
                  }
                  baseCurrency {
                    symbol
                  }
                  quoteCurrency {
                    symbol
                  }
                  quotePrice
                }
              }
            }`,
        },
        {
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': 'BQYmsfh6zyChKKHtKogwvrjXLw8AJkdP',
            },
        })
    return response.data.data.ethereum.dexTrades[0].quotePrice;
  } catch (err) {
    console.error("Problem retrieving price from bitquery for ", token);
    console.error(err);
    console.error(err.response.data.errors.message);
    res.json("Error retrieving price");
  }
}

async function executeLimitBuyOrders() {
  const query = "SELECT DISTINCT tokenOutAddress FROM limitBuy WHERE orderStatus = 'PENDING' OR orderStatus = 'ATTEMPTED'"
  try {
    const [results, fields] = await limitBuyPool.query(query);
    if (!results[0]) {
      console.error("No tokens found")
      return;
    } else {
      for (const result of results) {
        const latestPrice = await retrievePrice(result.tokenOutAddress);
        await executeLimitBuyOrdersForToken(result.tokenOutAddress, latestPrice);
      }
    }
  } catch (err) {
    console.error("error", err);
  }
}

async function executeLimitSellOrders() {
  const query = "SELECT DISTINCT tokenInAddress FROM limitSell WHERE orderStatus = 'PENDING' OR orderStatus = 'ATTEMPTED'"
  try {
    const [results, fields] = await limitSellPool.query(query);
    if (!results[0]) {
      console.error("No tokens found")
      return;
    } else {
      for (const result of results) {
        const latestPrice = await retrievePrice(result.tokenInAddress);
        await executeLimitSellOrdersForToken(result.tokenInAddress, latestPrice);
      }
    }
  } catch (err) {
    console.error("error", err);
  }
}

async function executeStopLossOrders() {
  const query = "SELECT DISTINCT tokenInAddress FROM stopLoss WHERE orderStatus = 'PENDING' OR orderStatus = 'ATTEMPTED'"
  try {
    const [results, fields] = await stopLossPool.query(query);
    if (!results[0]) {
      console.error("No tokens found")
      return;
    } else {
      for (const result of results) {
        const latestPrice = await retrievePrice(result.tokenInAddress);
        await executeStopLossOrdersForToken(result.tokenInAddress, latestPrice);
      }
    }
  } catch (err) {
    console.error("error", err);
  }
}

async function executeLimitBuyOrdersForToken(token, latestPrice) {
  const currentTime = Math.round(new Date() / 1000)
  const retryTime = currentTime - 300;

  // Eg. 1 BNB = 5 CAKE -> latestPrice = 0.2
  // Price falls -> 1 BNB = 10 CAKE -> latestPrice = 0.1

  const query = "SELECT * FROM limitBuy WHERE tokenPrice < " + 1 / latestPrice + " AND " + retryTime + " > lastAttemptedTime " + 
    "AND attempts < 5 AND (orderStatus = 'PENDING' OR orderStatus = 'ATTEMPTED') AND tokenOutAddress = \"" + token + "\"";
  try {
    var [results, fields] = await limitBuyPool.query(query);
    // For testing
    // var results = [
    //   {
    //   ordererAddress: '0x151bea96e4aed5f6a22aa8d4d52ca4a703e68754',
    //   tokenInAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    //   tokenOutAddress: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
    //   tokenInAmount: 10000000000000000,
    //   tokenOutAmount: 4000000000000000,
    //   slippage: 1200,
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
      var finalTokenOutValue = 0;
      for (const order of results) {
        var updateQuery;

        try {
          finalTokenOutValue = Math.max(Math.trunc(order.tokenOutAmount * (10000 - order.slippage) / 10000), 1)
          console.error("Attempting limit buy order ", order, finalTokenOutValue, currentTime + 300)
          const gasEstimate = await UtopiaLimitBuyRouter.methods
            .makeBNBTokenSwap(order.ordererAddress, order.tokenInAddress.toLowerCase(), order.tokenOutAddress.toLowerCase(), order.tokenInAmount.toString(), finalTokenOutValue.toString(), currentTime + 300)
            .estimateGas({ from: web3.eth.defaultAccount });
          const res = await UtopiaLimitBuyRouter.methods.makeBNBTokenSwap(order.ordererAddress, order.tokenInAddress.toLowerCase(), order.tokenOutAddress.toLowerCase(), order.tokenInAmount.toString(), finalTokenOutValue.toString(), currentTime + 300).send({
            from: web3.eth.defaultAccount,
            gasPrice: Math.trunc(gasPrice * 1.1),
            gas: Math.trunc(gasEstimate * 1.5),
          })

          if (res.status == true) {
            updateQuery = "UPDATE limitBuy SET attempts = " + (order.attempts + 1) + ", orderStatus = 'COMPLETED', executionTxHash = '" + res.transactionHash.toLowerCase() + "' WHERE orderCode = '" + order.orderCode + "'";
            console.error("Order has been successfully executed ", res.transactionHash)
            // Send BNB to owner address
          } else {
            if (order.attempts >= 4) {
              updateQuery = "UPDATE limitBuy SET attempts = " + (order.attempts + 1) + ", orderStatus = 'FAILED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
              console.error("Issue with order, will not attempt order again ", order, finalTokenOutValue)
            } else {
              updateQuery = "UPDATE limitBuy SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
              console.error("Issue with order,", order, finalTokenOutValue, " for attempt number ", order.attempts)
            }
          }
        } catch (err) {
          console.error("Error executing transaction", err);
          if (err.toString().includes("Invalid JSON RPC response:")) {
            console.error("Issue with JSON RPC Node, not updating database");
          }
          if (order.attempts >= 4) {
            updateQuery = "UPDATE limitBuy SET attempts = " + (order.attempts + 1) + ", orderStatus = 'FAILED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
            console.error("Issue with order, will not attempt order again ", order, finalTokenOutValue)
          } else {
            updateQuery = "UPDATE limitBuy SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
            console.error("Issue with order,", order, finalTokenOutValue, " for attempt number ", order.attempts)
          }
        }
        // Update limit order details
        console.error("Update order query ", updateQuery)
        try {
          await limitBuyPool.query(updateQuery).catch((error) => {
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

async function executeLimitSellOrdersForToken(token, latestPrice) {
  const currentTime = Math.round(new Date() / 1000)
  const retryTime = currentTime - 300;

  const query = "SELECT * FROM limitSell WHERE tokenPrice < " + latestPrice + " AND " + retryTime + " > lastAttemptedTime " + 
    "AND attempts < 5 AND (orderStatus = 'PENDING' OR orderStatus = 'ATTEMPTED') AND tokenInAddress=\"" + token + "\"";
  try {
    var [results, fields] = await limitSellPool.query(query);
    if (!results[0]) {
      // No limit sell orders found for change in price
      return;
    } else {
      // Execute order 
      const gasPrice = await web3.eth.getGasPrice();
      var finalTokenOutValue = 0;
      for (const order of results) {
        var updateQuery;
        let pairAddress = await getPairAddress(order.tokenInAddress, order.tokenOutAddress);
        try {
          finalTokenOutValue = Math.trunc(order.tokenOutAmount * (10000 - (order.slippage + 50)) / 10000);
          console.log("Attempting limit sell order ", order, finalTokenOutValue, currentTime + 300);

          const gasEstimate = await UtopiaStopLossRouter.methods
            .makeTokenBnbSwap(order.ordererAddress, 
              order.tokenInAddress.toLowerCase(), 
              order.tokenOutAddress.toLowerCase(), 
              pairAddress,
              order.tokenInAmount.toString(), 
              finalTokenOutValue.toString())
            .estimateGas({ from: web3.eth.defaultAccount });

          const res = await UtopiaStopLossRouter.methods.makeTokenBnbSwap(order.ordererAddress, 
            order.tokenInAddress.toLowerCase(),  
            order.tokenOutAddress.toLowerCase(), 
            pairAddress,
            order.tokenInAmount.toString(), 
            finalTokenOutValue.toString()).send({
              from: web3.eth.defaultAccount,
              gasPrice: Math.trunc(gasPrice * 1.1),
              gas: Math.trunc(gasEstimate * 1.5),
            })
            console.log("abcdeabcde");
            console.log(res);
            console.log("abcdeabcde");
          if (res.status == true) {
            console.log("abcdeabcde");
            updateQuery = "UPDATE limitSell SET attempts = " + (order.attempts + 1) + ", orderStatus = 'COMPLETED', executionTxHash = '" + res.transactionHash.toLowerCase() + "' WHERE orderCode = '" + order.orderCode + "'";
            console.error("Order has been successfully executed ", res.transactionHash)
            // Send BNB to owner address
          } else {
            if (order.attempts >= 4) {
              updateQuery = "UPDATE limitSell SET attempts = " + (order.attempts + 1) + ", orderStatus = 'FAILED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
              console.error("Issue with order, will not attempt order again ", order, pairAddress, finalTokenOutValue)
            } else {
              updateQuery = "UPDATE limitSell SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
              console.error("Issue with order,", order, pairAddress, finalTokenOutValue, " for attempt number ", order.attempts)
            }
          }
        } catch (err) {
          console.error("Error executing transaction", err);
          if (err.toString().includes("Invalid JSON RPC response:")) {
            console.error("Issue with JSON RPC Node, not updating database");
          }
          if (order.attempts >= 4) {
            updateQuery = "UPDATE limitSell SET attempts = " + (order.attempts + 1) + ", orderStatus = 'FAILED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
            console.error("Issue with order, will not attempt order again ", order, pairAddress, finalTokenOutValue)
          } else {
            updateQuery = "UPDATE limitSell SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
            console.error("Issue with order,", order, pairAddress, finalTokenOutValue, " for attempt number ", order.attempts)
          }
        }
        // Update limit order details
        console.error("Update order query ", updateQuery)
        try {
          await limitSellPool.query(updateQuery).catch((error) => {
            console.error("Execution of query to update limit sell order failed", error)
          })
        } catch (err) {
          console.error("Creation of connection to update limit sell order failed", err)
        }
      }
    }
  } catch (error) {
    console.error("error", error);
  }
}

async function executeStopLossOrdersForToken(token, latestPrice) {
  const currentTime = Math.round(new Date() / 1000)
  const retryTime = currentTime - 300;

  const query = "SELECT * FROM stopLoss WHERE tokenPrice < " + latestPrice + " AND " + retryTime + " > lastAttemptedTime " + 
    "AND attempts < 5 AND (orderStatus = 'PENDING' OR orderStatus = 'ATTEMPTED') AND tokenInAddress=\"" + token + "\"";
  try {
    var [results, fields] = await stopLossPool.query(query);
    // For testing
    // var results = [
    //   {
    //   ordererAddress: '0x431893403d0bd9FEE90E5ed5a9ed1BC93Be640e7',
    //   tokenInAddress: '0x1a1d7c7a92e8d7f0de10ae532ecd9f63b7eaf67c',
    //   tokenOutAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    //   pairAddress: await getPairAddress('0x1a1d7c7a92e8d7f0de10ae532ecd9f63b7eaf67c', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'),
    //   tokenInAmount: 10000,
    //   tokenOutAmount: 1,
    //   slippage: 1500,
    //   tokenPrice: 0.000000002144,
    //   customTaxForToken: false,
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
        let pairAddress = await getPairAddress(order.tokenInAddress, order.tokenOutAddress);
        var updateQuery;
        try {
          console.log("Attempting stop loss order ", order, pairAddress, currentTime + 300)

          const gasEstimate = await UtopiaStopLossRouter.methods
            .makeTokenBnbSwap(order.ordererAddress, 
              order.tokenInAddress.toLowerCase(), 
              order.tokenOutAddress.toLowerCase(), 
              pairAddress,
              order.tokenInAmount.toString(), 
              1)
            .estimateGas({ from: web3.eth.defaultAccount });

          const res = await UtopiaStopLossRouter.methods.makeTokenBnbSwap(order.ordererAddress, 
            order.tokenInAddress.toLowerCase(),  
            order.tokenOutAddress.toLowerCase(), 
            pairAddress,
            order.tokenInAmount.toString(), 
            1).send({
              from: web3.eth.defaultAccount,
              gasPrice: Math.trunc(gasPrice * 1.1),
              gas: Math.trunc(gasEstimate * 1.5),
            })

          if (res.status == true) {
            updateQuery = "UPDATE stopLoss SET attempts = " + (order.attempts + 1) + ", orderStatus = 'COMPLETED', executionTxHash = '" + res.transactionHash.toLowerCase() + "' WHERE orderCode = '" + order.orderCode + "'";
            console.error("Order has been successfully executed ", res.transactionHash)
          } else {
            if (order.attempts >= 4) {
              updateQuery = "UPDATE stopLoss SET attempts = " + (order.attempts + 1) + ", orderStatus = 'FAILED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
              console.error("Issue with order, will not attempt order again ", order, pairAddress)
            } else {
              updateQuery = "UPDATE stopLoss SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
              console.error("Issue with order,", order, pairAddress, " for attempt number ", order.attempts)
            }
          }
        } catch (err) {
          console.error("Error executing transaction", err);
          if (err.toString().includes("Invalid JSON RPC response:")) {
            console.error("Issue with JSON RPC Node, not updating database");
          }
          if (order.attempts >= 4) {
            updateQuery = "UPDATE stopLoss SET attempts = " + (order.attempts + 1) + ", orderStatus = 'FAILED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
            console.error("Issue with order, will not attempt order again ", order, pairAddress)
          } else {
            updateQuery = "UPDATE stopLoss SET attempts = " + (order.attempts + 1) + ", orderStatus = 'ATTEMPTED', lastAttemptedTime = " + currentTime + " WHERE orderCode = '" + order.orderCode + "'";
            console.error("Issue with order,", order, pairAddress, " for attempt number ", order.attempts)
          }
        }
        // Update limit order details
        console.error("Update order query ", updateQuery)
        try {
          await stopLossPool.query(updateQuery).catch((error) => {
            console.error("Execution of query to update stop loss failed", error)
          })
        } catch (err) {
          console.error("Creation of connection to update stop loss failed", err)
        }
      }
    }
  } catch (error) {
    console.error("error", error);
  }
}

getPairAddress = async function (address0, address1) {
  const pairAddress = await pancakeswapFactoryV2.methods
    .getPair(address0, address1)
    .call();

  return pairAddress;
};