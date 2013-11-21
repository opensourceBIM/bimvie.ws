var Settings = {
	get3DViewerUrl: function(bimServerApi, roid){
		return "http://localhost:8080/bimsurfer/index.html?token=" + bimServerApi.token + "&roid=" + roid + "&server=" + bimServerApi.baseUrl;
	},
	getMenuItems: function(){
		return [
	        "dashboardLink",
	        "projectsLink",
	        "usersLink",
	        "usersettingsLink",
	        "serversettingsLink",
	        "serverinfoLink",
	        "gettingStartedLink",
	        "testingLink"
		];
	},
	usableBimServerVersion: function(version) {
		return version.major == 1 && version.minor == 2 && version.revision == 1;
	},
	getStaticServerAddress: function(callback){
		$.getJSON("getbimserveraddress", function(data){
			callback(data.address);
		}).fail(function(){
			callback(null);
		});
	},
	allowBimServerAddress: function() {
		return false;
	}
}