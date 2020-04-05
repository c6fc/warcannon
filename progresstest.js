'use strict';

const progress = require('cli-progress');

const multibar = new progress.MultiBar({
	format: "{bar} ETA: {eta}s {filename}",
	barsize: 80,
    clearOnComplete: false,
    hideCursor: true
 
}, progress.Presets.shades_grey);

var bars = {};
bars["this"] = multibar.create(20, 0, {filename: "test1.txt"});
bars["that"] = multibar.create(20, 0, {filename: "test-asd1291asdjshdjkh12ajkshlqwhdiw-sasdkwsdlk232---s2.txt"});

function updateBar(which, what) {
	which.update(what);
}

var count = 0;
function doCount() {

	if (count == 20) {
		return true;
	}

	count++;

	var barNum = 0;
	Object.keys(bars).forEach(function (e) {
		barNum++;
		if (count + barNum > 5) {
			multibar.remove(bars[e]);
			delete bars[e]
		} else {
			bars[e].update(count + barNum);
		}
	});

	setTimeout(function() {
		doCount()
	}, 1000);
}

doCount();