'use strict';

const fs = require('fs');
const glob = require('glob');

var results_path = process.argv[2];

var metrics = {
	domains: {},
	regex: {}
};

glob(results_path + '/*_of_*.json', function(err, files) {
	if (err) {
		return err
	}

	files.forEach((f) => {
		var contents = JSON.parse(fs.readFileSync(f));

		Object.keys(contents.regex_hits).forEach((r) => {
			if (!metrics.regex.hasOwnProperty(r)) {
				metrics.regex[r] = { domains: [], hits: 0 };
			}

			Object.keys(contents.regex_hits[r].domains).forEach((d) => {

				/*
				if (['au', 'br', 'uk', 'hk', 'tw'].indexOf(d.split('.').splice(-1).toString()) >= 0) {
					var d2 = d.split('.').splice(-3).join('.');
				} else {
					var d2 = d.split('.').splice(-2).join('.');
				}
				*/

				if (!metrics.domains.hasOwnProperty(d)) {
					metrics.domains[d] = [];
				}

				if (metrics.regex[r].indexOf(d) < 0) {
					metrics.regex[r].push(d);
				}

				contents.regex_hits[r].domains[d].forEach((e) => {
					if (metrics.regex_hits[r].domains[d].indexOf(e) < 0) {
						metrics.total_hits++;
						metrics.regex_hits[r].hits++;
						metrics.regex_hits[r].domains[d].push(e);
					}
				})
			});
		});
	})

	fs.writeFileSync(results_path + "/merged.json", JSON.stringify(metrics));

	metrics = JSON.parse(fs.readFileSync(results_path + "/merged.json"));
	processMergedResults();
	console.log("[+] Merged and Processed results written to " + results_path);
});

function processMergedResults() {

	var processed_results = {
		trifecta_domains: [],
		user_pool_with_client_id: [],
		hosted_ui_with_identity_pool: [],
		identity_pool_reversed_domain_list: []
	};

	Object.keys(metrics.regex_hits.user_pool_id.domains).forEach((d) => {
		if (metrics.regex_hits.hosted_ui.domains.hasOwnProperty(d) && metrics.regex_hits.identity_pool_id.domains.hasOwnProperty(d)) {
			processed_results.trifecta_domains.push(d);
		}

		if (metrics.regex_hits.hosted_ui.domains.hasOwnProperty(d)) {
			processed_results.user_pool_with_client_id.push(d);
		}		
	});

	Object.keys(metrics.regex_hits.identity_pool_id.domains).forEach((d) => {
		if (metrics.regex_hits.hosted_ui.domains.hasOwnProperty(d)) {
			processed_results.hosted_ui_with_identity_pool.push(d);
		}

		var reversed = d.split('.').reverse().join('.');
		if (processed_results.identity_pool_reversed_domain_list.indexOf(reversed) < 0) {
			processed_results.identity_pool_reversed_domain_list.push(reversed);
		}

		processed_results.identity_pool_reversed_domain_list.sort();
	});

	Object.keys(metrics.regex_hits.identity_pool_id.domains).forEach((d) => {
		if (metrics.regex_hits.hosted_ui.domains.hasOwnProperty(d)) {
			processed_results.hosted_ui_with_identity_pool.push(d);
		}
	});

	fs.writeFileSync(results_path + "/processed_results.json", JSON.stringify(processed_results));
}