import cds from '@sap/cds';
import xsenv from '@sap/xsenv';
import * as xssec from '@sap/xssec';
import JobsClient from '@sap/jobs-client';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { circuitBreaker } from '@sap-cloud-sdk/resilience';

const LOG = cds.log('monitoring');

xsenv.loadEnv();

const serviceBindings = {};

try {
  Object.assign(serviceBindings, xsenv.getServices({
    objectStore: { tag: 'objectstore' }
  }));
} catch (error) {
  LOG.warn('Object Store service binding not found: %s', error.message);
}

try {
  Object.assign(serviceBindings, xsenv.getServices({
    jobscheduler: { tag: 'jobscheduler' }
  }));
} catch (error) {
  LOG.warn('Job Scheduler service binding not found: %s', error.message);
}

const objectStoreCredentials = serviceBindings.objectStore?.credentials || serviceBindings.objectStore;
const jobsCredentials = serviceBindings.jobscheduler?.credentials || serviceBindings.jobscheduler;

const bucketName = process.env.OBJECT_STORE_BUCKET
  || objectStoreCredentials?.bucket
  || objectStoreCredentials?.bucket_name
  || objectStoreCredentials?.bucketName;

const accessKeyId = objectStoreCredentials?.access_key_id
  || objectStoreCredentials?.accessKeyId
  || objectStoreCredentials?.accesskey
  || objectStoreCredentials?.access_key;

const secretAccessKey = objectStoreCredentials?.secret_access_key
  || objectStoreCredentials?.secretAccessKey
  || objectStoreCredentials?.secretaccesskey
  || objectStoreCredentials?.secret_key;

const s3Client = objectStoreCredentials
  ? new S3Client({
      region: objectStoreCredentials.region || process.env.AWS_REGION || 'eu10',
      endpoint: objectStoreCredentials.endpoint || objectStoreCredentials.url,
      forcePathStyle: true,
      credentials: accessKeyId && secretAccessKey ? {
        accessKeyId,
        secretAccessKey
      } : undefined
    })
  : null;

const schedulerBaseUrl = jobsCredentials?.url || jobsCredentials?.schedulerUrl || jobsCredentials?.schedulerURL;

const uaaUrl = jobsCredentials?.uaa?.url
  || jobsCredentials?.uaa?.tokenurl
  || jobsCredentials?.uaa?.tokenUrl
  || jobsCredentials?.tokenURL
  || jobsCredentials?.tokenurl;

const tokenURL = uaaUrl ? (uaaUrl.includes('/oauth/token') ? uaaUrl : `${uaaUrl}/oauth/token`) : undefined;

const jobSchedulerClient = jobsCredentials && tokenURL
  ? new JobsClient.Scheduler({
      schedulerURL: schedulerBaseUrl,
      clientId: jobsCredentials.uaa?.clientid || jobsCredentials.clientid || jobsCredentials.clientId,
      clientSecret: jobsCredentials.uaa?.clientsecret || jobsCredentials.clientsecret || jobsCredentials.clientSecret,
      tokenURL
    })
  : null;

const jwtStrategy = jobsCredentials?.uaa ? new xssec.JWTStrategy(jobsCredentials.uaa) : null;

if (jwtStrategy) {
  LOG.info('JWT strategy initialised for Job Scheduler callbacks.');
}

const healthCheckBreaker = circuitBreaker(async () => {
  if (!schedulerBaseUrl) {
    return { status: 'UNBOUND' };
  }
  const response = await executeHttpRequest({
    baseURL: schedulerBaseUrl
  }, {
    method: 'get',
    url: '/scheduler/health'
  });
  return response.data;
}, {
  timeout: 1000,
  name: 'jobs-health'
});

async function ensureMonitoringJob(jobName) {
  if (!jobSchedulerClient) {
    LOG.info('Job Scheduler client not initialised; skipping job provisioning.');
    return;
  }

  const jobDefinition = {
    name: jobName,
    description: 'Monitors the SAP Object Store for newly added files',
    action: {
      type: 'http',
      target: `${process.env.MONITORING_CALLBACK_URL || 'http://localhost:4004'}${process.env.MONITORING_CALLBACK_PATH || '/odata/v4/MonitoringService/CheckBucket'}`,
      httpMethod: 'POST'
    },
    schedules: [{
      description: 'Default schedule that runs every five minutes',
      cron: process.env.MONITORING_JOB_CRON || '0 */5 * * * *'
    }],
    active: true
  };

  const wrap = (fn, payload) => new Promise((resolve, reject) => {
    fn.call(jobSchedulerClient, payload, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });

  try {
    await wrap(jobSchedulerClient.updateJob, jobDefinition);
    LOG.info('Updated existing monitoring job "%s".', jobName);
  } catch (error) {
    if (error?.response?.statusCode === 404 || error?.statusCode === 404) {
      await wrap(jobSchedulerClient.createJob, jobDefinition);
      LOG.info('Created monitoring job "%s".', jobName);
    } else {
      LOG.warn('Failed to provision job "%s": %s', jobName, error.message || error.toString());
    }
  }
}

async function listObjects(bucket) {
  if (!s3Client) {
    throw new cds.error('Object Store service is not bound.');
  }

  const command = new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 });
  const response = await s3Client.send(command);
  return response.Contents || [];
}

async function persistStatus(bucket, entries) {
  if (!entries.length || !s3Client) {
    return;
  }

  const statusBody = Buffer.from(JSON.stringify({
    timestamp: new Date().toISOString(),
    bucket,
    newObjects: entries.map(entry => ({ key: entry.objectKey, size: entry.size, eTag: entry.eTag, lastModified: entry.lastModified }))
  }, null, 2));

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: `${process.env.MONITORING_STATUS_PREFIX || 'monitoring-status'}/last-run.json`,
      Body: statusBody,
      ContentType: 'application/json'
    }
  });

  await upload.done();
}

class MonitoringService extends cds.ApplicationService {
  async init() {
    if (jobSchedulerClient) {
      const jobName = process.env.MONITORING_JOB_NAME || 'cap-object-store-monitor';
      ensureMonitoringJob(jobName).catch(err => {
        LOG.warn('Unable to ensure monitoring job: %s', err.message || err.toString());
      });
    }

    healthCheckBreaker.execute().then(result => {
      LOG.info('Job Scheduler health status: %j', result);
    }).catch(error => {
      LOG.warn('Failed to retrieve Job Scheduler health: %s', error.message || error.toString());
    });

    this.before(['CheckBucket'], async req => {
      if (!jwtStrategy || !req.headers?.authorization) {
        return;
      }

      const token = req.headers.authorization.replace(/^Bearer\s+/i, '');
      await new Promise((resolve, reject) => {
        xssec.createSecurityContext(token, jwtStrategy, (err, securityContext) => {
          if (err) {
            reject(new cds.error('Unauthorized', { status: 401 }));
            return;
          }
          const userId = securityContext.getLogonName();
          const roles = securityContext.getAttribute('xs.system.roles') || [];
          req.user = new cds.User({ id: userId, roles });
          resolve();
        });
      });
    });

    this.on('CheckBucket', async req => {
      const requestedBucket = req.data.bucket || bucketName;
      if (!requestedBucket) {
        req.error(400, 'Bucket name must be provided via action parameter or service binding.');
        return [];
      }

      const tx = cds.transaction(req);
      const { SELECT, INSERT, UPDATE } = cds.ql;

      const objects = await listObjects(requestedBucket);
      const existing = await tx.run(SELECT.from('monitoring.TrackedFiles').where({ bucket: requestedBucket }));
      const existingMap = new Map(existing.map(item => [item.objectKey, item]));

      const newEntries = [];

      for (const object of objects) {
        const key = object.Key;
        const normalizedEtag = object.ETag?.replace(/"/g, '');
        const known = existingMap.get(key);
        if (!known) {
          const entry = {
            ID: cds.utils.uuid(),
            bucket: requestedBucket,
            objectKey: key,
            eTag: normalizedEtag,
            size: object.Size,
            lastModified: object.LastModified,
            processedAt: new Date()
          };
          await tx.run(INSERT.into('monitoring.TrackedFiles').entries(entry));
          newEntries.push(entry);
        } else if (known.eTag !== normalizedEtag) {
          const updated = {
            eTag: normalizedEtag,
            size: object.Size,
            lastModified: object.LastModified,
            processedAt: new Date()
          };
          await tx.run(UPDATE('monitoring.TrackedFiles').set(updated).where({ ID: known.ID }));
          newEntries.push({ ...known, ...updated });
        }
      }

      await persistStatus(requestedBucket, newEntries);

      return newEntries;
    });

    this.on('READ', 'TrackedFiles', async req => {
      const tx = cds.transaction(req);
      return tx.run(req.query);
    });

    return super.init();
  }
}

export default MonitoringService;
