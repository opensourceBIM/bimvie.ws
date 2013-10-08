var Settings = {
	get3DViewerUrl: function(bimServerApi, roid){
		return "http://test.bimsurfer.org/index.html?token=" + bimServerApi.token + "&roid=" + roid + "&server=" + bimServerApi.baseUrl;
	},
	getMenuItems: function(){
		return [
	        "dashboardLink",
	        "projectsLink",
	        "usersLink",
	        "usersettingsLink",
	        "serversettingsLink",
	        "serverinfoLink"
		];
	},
	getStaticServerAddress: function(callback){
	},
	allowBimServerAddress: function() {
		return true;
	}
}