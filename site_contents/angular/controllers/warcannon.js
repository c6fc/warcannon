angular
	.module('warcannon', [])
	.controller('statusCtrl', ['$scope', '$timeout', function($scope, $timeout) {

		$scope.loaded = false;
		$scope.timeout = false;

		$scope.metrics = [];
		$scope.last_progress = 0;

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
				$scope.metrics = data.metrics;
				$scope.last_progress = (data.generated == 0) ? "never" : new Date(data.generated).toLocaleTimeString();

				console.log($scope.metrics);

				$scope.$digest();

			}, (err) => {
				console.log(err);
			});
		}

		$scope.startTimeout = function() {
			$scope.updateMetrics();

			/*
			$scope.timeout = $timeout(function() {
				$scope.startTimeout();
			}, 5000);
			*/
		}

		$scope.startTimeout();
	}]);