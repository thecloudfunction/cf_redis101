import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

admin.initializeApp()

const REDIS_PORT = 6379
const REDIS_HOST = `10.0.0.3`
const REDIS_NAME = `edis-zero-to-prod`

const firestore = admin.firestore()
const ordersRef = firestore.collection(`orders`)

const redisLib = require('redis')
const client = redisLib.createClient(REDIS_PORT, REDIS_HOST)

const fromCache = (key: string): Promise<string | null> => new Promise(async resolve => {
  if (client.connected === false) {
    resolve(null) 
  } else {
    // @ts-ignore
    return await client.get(key, function(_err, reply) {
      resolve(reply)
    })
  }
})

export const redis = functions.https.onRequest(async (req, res) => {
  const id = req.query.id
  let response: string | null = await fromCache(id)
  if (response) {
    res.status(200).send(Object.assign({}, JSON.parse(response), { from: 'redis' }))
  } else {
    let record = await ordersRef.doc(id).get().then(doc => doc.exists ? doc.data() : null)
    if (record) {
      if (client.connected === true) {
        await client.set(id, JSON.stringify(record))
      }
      res.status(200).send(Object.assign({}, record, { from: 'firestore' }))
    } else {
      res.status(404).send({ message: `not found`})
    }
  }
})

export const cacheUpdate = functions
  .firestore.document(`orders/{doc}`).onWrite(async (change, _context) => {
    const oldData = change.before
    const newData = change.after
    const data = newData.data()
    const id = newData.id

    if (!oldData.exists && newData.exists) {
        // creating
         await client.set(id, JSON.stringify(data))
         return Promise.resolve(true)
      } else if (!newData.exists && oldData.exists) {
        // deleting
        await client.del(id)
        return Promise.resolve(true)
      } else  {
        // updating
        await client.set(id, JSON.stringify(data))
        return Promise.resolve(true)
    }
})

// Init instance at 7am based on server time, from Mond to Frid
export const createInstance = functions.pubsub.schedule(`0 7 * * 1-5`).onRun(async () => {
  const memoryStore = require('@google-cloud/redis')
  
  const memoryStoreClient = new memoryStore.v1.CloudRedisClient()

  const formattedParent = memoryStoreClient.locationPath(process.env.GCLOUD_PROJECT, process.env.FUNCTION_REGION);
  const instanceId = REDIS_NAME
  const instance = {
    tier: 'BASIC',
    memorySizeGb: 1,
    // reservedIpRange: `10.0.0.0/30` // 10.0.0.1 - 10.0.0.2  
  }
  const request = {
    parent: formattedParent,
    instanceId: instanceId,
    instance: instance,
  }
  const [operation] = await memoryStoreClient.createInstance(request)
  const [response] = await operation.promise()
  return Promise.resolve(response)
})

// Terminate instance at 7pm based on server time, from Mond to Frid
export const deleteInstance = functions.pubsub.schedule(`0 19 * * 1-5`).onRun(async () => {
  const memoryStore = require('@google-cloud/redis')
  const memoryStoreClient = new memoryStore.v1.CloudRedisClient()
  const formattedName = memoryStoreClient.instancePath(process.env.GCLOUD_PROJECT, process.env.FUNCTION_REGION, REDIS_NAME);
  const [operation] = await memoryStoreClient.deleteInstance({name: formattedName});
  const [response] = await operation.promise();
  return Promise.resolve(response)
})