-- The app's id for one receipt upload. The app keeps a receipt it could not send (filtered or cut line) and sends it
-- again later with the same id; when the first try did arrive and only its answer was lost, the Worker sees the same
-- id and answers without sending the photo to the admin a second time.
ALTER TABLE orders ADD COLUMN receipt_upload TEXT;
