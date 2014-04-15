var Settings = {
	createStartPage: function(container, main){
		main.pageChanger.changePage($(".serverinfoLink"), "projects.html", function(){
			return new Projects($(this), main);
		});
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
	getStaticServerAddress: function(callback){
	},
	usableBimServerVersion: function(version) {
		return version.major == 1 && version.minor == 3 && version.revision == 0;
	},
	allowBimServerAddress: function() {
		return true;
	},
	getPlugins: function(){
		return {
		};
	},
}