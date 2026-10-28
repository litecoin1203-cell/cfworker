-- settle() claims an order (status 'settling') before delivering it, so two confirmations at the same time
-- (bank SMS + admin button + chain watcher) cannot deliver it twice. settling_at lets a crashed run's claim
-- expire; provisioned_at stops a retry from adding the plan's days to the panel account a second time.
ALTER TABLE orders ADD COLUMN settling_at INTEGER;
ALTER TABLE orders ADD COLUMN provisioned_at INTEGER;
