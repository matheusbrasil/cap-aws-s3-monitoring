using monitoring as db from '../db/schema';

service MonitoringService {
  entity TrackedFiles as projection on db.TrackedFiles;

  action CheckBucket(optional bucket : String) returns many TrackedFiles;
}
