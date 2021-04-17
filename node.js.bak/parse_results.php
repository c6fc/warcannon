<?php

$db = new mysqli("localhost", "warcannon", $argv[1], "warcannon");

if (mysqli_connect_errno()) {
	echo "Unable to connect: " . mysqli_connect_error();
	exit();
}

$query = $db->prepare("INSERT INTO warcannon (`pattern`, `domain`, `match`, `targeturi`) VALUES (?, ?, ?, ?)");
$query->bind_param("ssss", $pattern, $domain, $match, $targeturi);

$metrics = json_decode(file_get_contents($argv[2]), true);

foreach ($metrics["regex_hits"] as $pattern => $domains) {
	foreach ($domains["domains"] as $domain => $results) {
		$targeturi = null;

		if ($pattern != "assumerolewithwebidentity") {
			foreach ($results["matches"] as $match) {
				$query->execute();
			}
		}

		$match = null;
		foreach ($results["target_uris"] as $targeturi) {
			$query->execute();
		}
	}
}


?>