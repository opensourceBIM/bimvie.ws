function CountingPromise() {
	var o = this;
	o.count = 0;
	o.doneSomething = false;
	
	this.inc = function(){
		o.count++;
		o.doneSomething = true;
	};
	
	this.dec = function(){
		o.count--;
		if (o.count == 0) {
			o.fire();
		}
	};
	
	this.done = function(callback){
		if (o.doneSomething && o.count == 0) {
			callback();
		} else {
			o.callback = callback;
		}
	};
	
	this.fire = function(){
		if (o.callback != null) {
			o.callback();
		}
	};
}

function formatAccessMethod(accessMethod) {
	if (accessMethod == "INTERNAL") {
		return "Internal";
	} else if (accessMethod == "JSON") {
		return "JSON";
	} else if (accessMethod == "WEB_INTERFACE") {
		return "Web Interface";
	} else {
		return accessMethod;
	}
}

function formatUserType(type) {
	if (type == "SYSTEM") {
		return "System";
	} else if (type == "ADMIN") {
		return "Administrator";
	} else if (type == "USER") {
		return "User";
	} else if (type == "READ_ONLY") {
		return "Read only";
	}
}

function formatTrigger(trigger) {
	if (trigger == "NEW_REVISION") {
		return "New revision";
	} else if (trigger == "NEW_EXTENDED_DATA") {
		return "New extended data";
	} else if (trigger == "NEW_PROJECT") {
		return "New project";
	}
}

function stripIfc(input) {
	if (input.startsWith("Ifc")) {
		return input.substring(3);
	} else {
		return input;
	}
}

var QueryString = function () {
	  // This function is anonymous, is executed immediately and 
	  // the return value is assigned to QueryString!
	  var query_string = {};
	  var query = window.location.search.substring(1);
	  var vars = query.split("&");
	  for (var i=0;i<vars.length;i++) {
	    var pair = vars[i].split("=");
	        // If first entry with this name
	    if (typeof query_string[pair[0]] === "undefined") {
	      query_string[pair[0]] = decodeURIComponent(pair[1]);
	        // If second entry with this name
	    } else if (typeof query_string[pair[0]] === "string") {
	      var arr = [ query_string[pair[0]],decodeURIComponent(pair[1]) ];
	      query_string[pair[0]] = arr;
	        // If third or later entry with this name
	    } else {
	      query_string[pair[0]].push(decodeURIComponent(pair[1]));
	    }
	  } 
	  return query_string;
	}();
