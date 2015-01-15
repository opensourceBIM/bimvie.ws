var Settings = {
	get3DViewerUrl: function(bimServerApi, roid){
		return "http://test.bimsurfer.org/index.html?token=" + bimServerApi.token + "&roid=" + roid + "&server=" + bimServerApi.baseUrl;
	},
	createStartPage: function(container, main){
		pushHistory({page: "Projects"}, "Projects");
		main.pageChanger.changePage($(".serverinfoLink"), "projects.html", function(){
			return new Projects($(this), main);
		});
	},
	getPlugins: function(){
		return {
			relatics: {
				enabled: false
			}
		};
	},
	getTitle: function(){
		return "BIMvie.ws";
	},
	useBimSurfer: function(){
		return true;
	},
	getMenuItems: function(){
		return [
	        "dashboardLink",
	        "userLink",
	        "projectLink",
	        "usersettingsLink",
	        "serversettingsLink",
	        "gettingStartedLink",
	        "userDivider",
	        "btnAddUser",
	        "btnListUsers"
		];
	},
	usableBimServerVersion: function(version) {
		return (version.major == 1 && version.minor == 3) || (version.major == 1 && version.minor == 4);
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
	},
	getDefaultHiddenTypes: function() {
		return {"IfcOpeningElement": true, "IfcSpace": true};
	}
}