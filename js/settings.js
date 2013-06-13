var Settings = {
	getServerList: function(callback){
		$.getJSON("http://extend.bimserver.org/serverlist", function(data, textStatus, jqXHR){
			callback(data.servers);
		}).error(function(error) {console.log(error); });
	},
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
	        "testingLink"
		];
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