namespace monitoring;

entity TrackedFiles {
  key ID         : UUID default uuid();
  bucket         : String(255);
  objectKey      : String(1024);
  eTag           : String(255);
  size           : Integer64;
  lastModified   : Timestamp;
  processedAt    : Timestamp;
}
