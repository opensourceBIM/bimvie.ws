var Settings = {
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
	getVersion: function(successCallback){
		// Sends back the version to the successCallback, default case would be to assume BIMserver to be running on the same webserver (hence asking for the plugin.version resource)
		// When running BIMvie.ws on a different server, replace this with a callback with a fixed version
		// This version is usually used for the invalidation of the caching of BIMvie.ws resources

		var myRequest = new XMLHttpRequest();
		myRequest.onreadystatechange = function() {
			if (myRequest.readyState != 4)  {
				// We are waiting for a readyState 4 here
				return;
			}
			if (myRequest.status != 200)  {
				successCallback(new Date().getTime());
				return;
			} else {
				successCallback(JSON.parse(myRequest.responseText).version);
			}
		};
		myRequest.open("GET", Global.baseDir + "plugin.version", true);
		myRequest.send();
	},
	getStaticServerAddress: function(callback){
		$.getJSON("x.getbimserveraddress", function(data){
			callback(data.address);
		}).fail(function(){
			callback(null);
		});
	},
	useCompressedResources: function(){
		return true;
	},
	allowBimServerAddress: function() {
		return false;
	},
	getBimServerApiAddress: function(){
		return "deps/bimserverjsapi";
	},
	getBimSurferApiAddress: function(){
		return "deps/bimsurfer-v1";
	},
	getDefaultHiddenTypes: function() {
		return {"IfcOpeningElement": true, "IfcSpace": true};
	}
}