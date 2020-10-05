{
	table(name, billing, hash_key, range_key, attributes, gsi, ttl): {
		[name]: std.prune({
			name: name,
			billing_mode: billing,
			hash_key: hash_key,
			range_key: range_key,
			attribute: attributes,
			global_secondary_index: gsi,
			ttl: ttl
		})
	}
}