function PluginManager() {
	var o = this;
	o.byType = {};

	this.allOfType = function(type, callback){
		if (o.byType[type] != null) {
			o.byType[type].forEach(callback);
		}
	};
	
	this.register = function(pluginConstructor){
		var plugin = Object.create(pluginConstructor.prototype);
		console.log(plugin);
		var type = plugin.getType();
		if (o.byType[type] == null) {
			o.byType[type] = [];
		}
		o.byType[type].push(pluginConstructor);
	};
}

Global.pluginManager = new PluginManager();