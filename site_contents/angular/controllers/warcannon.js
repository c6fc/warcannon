angular
	.module('warcannon', [])
	.filter('momentfn', function () {
	    return function (input, momentFn /*, param1, param2, ...param n */) {
	  		var args = Array.prototype.slice.call(arguments, 2),
	        momentObj = moment(input);

	        if (input <= 0 && momentFn == 'fromNow') {
	        	return 'Never';
	        }

	    	return momentObj[momentFn].apply(momentObj, args);
	  	};
	})
	.controller('statusCtrl', ['$scope', '$timeout', function($scope, $timeout) {

		$scope.loaded = false;
		$scope.timeout = false;
		$scope.ticktock = 0;

		$scope.progress = {
			metrics: [],
			generated: 0,
			sqs: {
				ApproximateNumberOfMessages: "-",
				ApproximateNumberOfMessagesNotVisible: "-"
			}
		};

		$scope.getMetrics = function() {
			return new Promise((success, failure) => {
				$.ajax('progress.json?cb=' + Math.random())
				.then((data) => {
					success(data);
				}, (err) => {
					console.log(err);
					failure(err);
				});
			});
		}

		$scope.updateMetrics = function() {
			return $scope.getMetrics()
			.then((data) => {

				$scope.loaded = true;
				$scope.progress = data;


				$scope.ticktock = ($scope.ticktock > 0) ? 0 : 1;

				// I know this looks super hacky, but it's the only workaround I can find to force bindings to re-evaluate the moment filter.
				$scope.progress.generated -= $scope.ticktock;				
				Object.keys($scope.progress.metrics).forEach(function(m) {
					["timestamp"].forEach(function(e) {
						$scope.progress.metrics[m][e] -= $scope.ticktock;
					})

				});

				console.log($scope.progress);

				$scope.$digest();

			}, (err) => {
				console.log(err);
			});
		}

		$scope.startTimeout = function() {
			$scope.updateMetrics();

			$scope.timeout = $timeout(function() {
				$scope.startTimeout();
			}, 5000);
		};

		$scope.startTimeout();
	}]);