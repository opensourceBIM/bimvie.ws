"use strict"

// NodeJS stuff
if (XMLHttpRequest == null) {
	XMLHttpRequest = require("xhr2");
}

define(
    ["bimserverapi_BimServerWebSocket", "bimserverapi_BimServerApiPromise", "bimserverapi_Model", "bimserverapi_Ifc2x3tc1", "bimserverapi_Ifc4", "bimserverapi_Translations_EN"], 
    function(BimServerWebSocket, BimServerApiPromise, Model, ifc2x3tc1, ifc4, translations){
    return function(baseUrl, notifier) {
    	var othis = this;
    	
    	othis.interfaceMapping = {
    		"ServiceInterface": "org.bimserver.ServiceInterface",
    		"AuthInterface": "org.bimserver.AuthInterface",
    		"SettingsInterface": "org.bimserver.SettingsInterface",
    		"AdminInterface": "org.bimserver.AdminInterface",
    		"PluginInterface": "org.bimserver.PluginInterface",
    		"MetaInterface": "org.bimserver.MetaInterface",
    		"Bimsie1LowLevelInterface": "org.buildingsmart.bimsie1.Bimsie1LowLevelInterface",
    		"Bimsie1NotificationRegistryInterface": "org.buildingsmart.bimsie1.Bimsie1NotificationRegistryInterface",
    		"Bimsie1AuthInterface": "org.buildingsmart.bimsie1.Bimsie1AuthInterface",
    		"Bimsie1ServiceInterface": "org.buildingsmart.bimsie1.Bimsie1ServiceInterface"
    	};

    	// Current BIMserver token
    	othis.token = null;
    	
    	// Base URL of the BIMserver
    	othis.baseUrl = baseUrl;
    	if (othis.baseUrl.substring(othis.baseUrl.length - 1) == "/") {
    		othis.baseUrl = othis.baseUrl.substring(0, othis.baseUrl.length - 1);
    	}
    	
    	// JSON endpoint on BIMserver
    	othis.address = othis.baseUrl + "/json";
    	
    	// Notifier, default implementation does nothing
    	othis.notifier = notifier;
    	if (othis.notifier == null) {
    		othis.notifier = {
    			setInfo: function(message, timeout){},
    			setSuccess: function(message, timeout){},
    			setError: function(){},
    			resetStatus: function(){},
    			resetStatusQuick: function(){},
    			clear: function(){}
    		};
    	}
    	
    	// The websocket client
    	othis.webSocket = new BimServerWebSocket(baseUrl, othis);
    	
    	// Cached user object
    	othis.user = null;
    	
    	othis.listeners = {};   	
    	
//    	othis.autoLoginTried = false;
    	
    	// Cache for serializers, PluginClassName(String) -> Serializer
    	othis.serializersByPluginClassName = [];

    	// Whether debugging is enabled, just a lot more logging
    	othis.debug = false;
    	
    	// Mapping from ChannelId -> Listener (function)
    	othis.binaryDataListener = {};
    	
    	// This mapping keeps track of the prototype objects per class, will be lazily popuplated by the getClass method
    	othis.classes = {};
    	
    	// Schema name (String) -> Schema
    	othis.schemas = {};

    	this.init = function(callback) {
    		othis.call("AdminInterface", "getServerInfo", {}, function(serverInfo){
    			othis.version = serverInfo.version;
    			var versionString = othis.version.major + "." + othis.version.minor + "." + othis.version.revision;

				othis.schemas["ifc2x3tc1"] = ifc2x3tc1.classes;
				othis.addSubtypesToSchema(ifc2x3tc1.classes);

				othis.schemas["ifc4"] = ifc4.classes;
				othis.addSubtypesToSchema(ifc4.classes);

				callback(othis, serverInfo);
    		});
    	};

    	this.addSubtypesToSchema = function(classes) {
    		for (var typeName in classes) {
    			var type = classes[typeName];
    			if (type.superclasses != null) {
    				type.superclasses.forEach(function(superClass){
    					var directSubClasses = classes[superClass].directSubClasses;
    					if (directSubClasses == null) {
    						directSubClasses = [];
    						classes[superClass].directSubClasses = directSubClasses;
    					}
    					directSubClasses.push(typeName);
    				});
    			}
    		}
    	};
    	
    	this.getAllSubTypes = function(schema, typeName, callback) {
    		var type = schema[typeName];
    		if (type.directSubClasses != null) {
    			type.directSubClasses.forEach(function(subTypeName){
    				callback(subTypeName);
    				othis.getAllSubTypes(schema, subTypeName, callback);
    			});
    		}
    	};
    	
    	this.log = function(message, message2){
    		if (othis.debug) {
    			console.log(message, message2);
    		}
    	};
    	
    	this.translate = function(key) {
    		key = key.toUpperCase();
    		if (translations != null) {
    			return translations[key];
    		}
    		othis.log("translation for " + key + " not found");
    		return key;
    	};

    	this.login = function(username, password, callback, errorCallback, options) {
    		if (options == null) {
    			options = {};
    		}
    		var request = {
    			username: username,
    			password: password
    		};
    		othis.call("Bimsie1AuthInterface", "login", request, function(data){
    			othis.token = data;
    			if (options.done != false) {
    				othis.notifier.setInfo("Login successful", 2000);
    			}
    			othis.resolveUser();
    			othis.webSocket.connect(callback);
    		}, errorCallback, options.busy == false ? false : true, options.done == false ? false : true, options.error == false ? false : true);
    	};

    	this.downloadViaWebsocket = function(msg){
    		msg.action = "download";
    		msg.token = othis.token;
    		othis.webSocket.send(msg);
    	};
    	
    	this.setBinaryDataListener = function(channelId, listener){
    		othis.binaryDataListener[channelId] = listener;
    	};
    	
    	this.processNotification = function(message) {
    		if (message instanceof ArrayBuffer) {
    			var view = new DataView(message, 0, 4);
    			var channelId = view.getInt32(0);
    			var listener = othis.binaryDataListener[channelId];
    			listener(message);
    		} else {
    			var intf = message["interface"];
    			if (othis.listeners[intf] != null) {
    				if (othis.listeners[intf][message.method] != null) {
    					var ar = null;
    					othis.listeners[intf][message.method].forEach(function(listener) {
    						if (ar == null) {
    							// Only parse the arguments once, or when there are no listeners, not even once
    							ar = [];
    							var i=0;
    							for (var key in message.parameters) {
    								ar[i++] = message.parameters[key];
    							}
    						}
    						listener.apply(null, ar);
    					});
    				} else {
    					console.log("No listeners on interface " + intf + " for method " + message.method);
    				}
    			} else {
    				console.log("No listeners for interface " + intf);
    			}
    		}
    	};

    	this.resolveUser = function(callback) {
    		othis.call("AuthInterface", "getLoggedInUser", {}, function(data){
    			othis.user = data;
    			if (callback != null) {
    				callback(othis.user);
    			}
    		});
    	};

    	this.logout = function(callback) {
    		othis.call("Bimsie1AuthInterface", "logout", {}, function(){
    			othis.notifier.setInfo("Logout successful");
    			callback();
    		});
    	};

    	this.generateRevisionDownloadUrl = function(settings) {
    		return othis.baseUrl + "/download?token=" + othis.token + (settings.zip ? "&zip=on" : "") + "&serializerOid=" + settings.serializerOid + "&topicId=" + settings.topicId;
    	};

    	this.generateExtendedDataDownloadUrl = function(edid) {
    		return othis.baseUrl + "/download?token=" + othis.token + "&action=extendeddata&edid=" + edid;
    	};

    	this.getJsonSerializer = function(callback) {
    		othis.getSerializerByPluginClassName("org.bimserver.serializers.JsonSerializerPlugin", callback);
    	};

    	this.getJsonStreamingSerializer = function(callback) {
    		othis.getSerializerByPluginClassName("org.bimserver.serializers.JsonStreamingSerializerPlugin", callback);
    	};
    	
    	this.getSerializerByPluginClassName = function(pluginClassName, callback) {
    		if (othis.serializersByPluginClassName[pluginClassName] == null) {
    			othis.call("PluginInterface", "getSerializerByPluginClassName", {pluginClassName : pluginClassName}, function(serializer) {
    				othis.serializersByPluginClassName[pluginClassName] = serializer;
    				callback(serializer);
    			});
    		} else {
    			callback(othis.serializersByPluginClassName[pluginClassName]);
    		}
    	};

    	this.getMessagingSerializerByPluginClassName = function(pluginClassName, callback) {
    		if (othis.serializersByPluginClassName[pluginClassName] == null) {
    			othis.call("PluginInterface", "getMessagingSerializerByPluginClassName", {pluginClassName : pluginClassName}, function(serializer) {
    				othis.serializersByPluginClassName[pluginClassName] = serializer;
    				callback(serializer);
    			});
    		} else {
    			callback(othis.serializersByPluginClassName[pluginClassName]);
    		}
    	};

    	this.register = function(interfaceName, methodName, callback, registerCallback) {
    		if (callback == null) {
    			throw "Cannot register null callback";
    		}
    		if (othis.listeners[interfaceName] == null) {
    			othis.listeners[interfaceName] = {};
    		}
    		if (othis.listeners[interfaceName][methodName] == null) {
    			othis.listeners[interfaceName][methodName] = [];
    		}
    		othis.listeners[interfaceName][methodName].push(callback);
    		if (registerCallback != null) {
    			registerCallback();
    		}
    	};

    	this.registerNewRevisionOnSpecificProjectHandler = function(poid, handler, callback){
    		othis.register("Bimsie1NotificationInterface", "newRevision", handler, function(){
    			othis.call("Bimsie1NotificationRegistryInterface", "registerNewRevisionOnSpecificProjectHandler", {endPointId: othis.webSocket.endPointId, poid: poid}, function(){
    				if (callback != null) {
    					callback();
    				}
    			});
    		});
    	};

    	this.registerNewExtendedDataOnRevisionHandler = function(roid, handler, callback){
    		othis.register("Bimsie1NotificationInterface", "newExtendedData", handler, function(){
    			othis.call("Bimsie1NotificationRegistryInterface", "registerNewExtendedDataOnRevisionHandler", {endPointId: othis.webSocket.endPointId, roid: roid}, function(){
    				if (callback != null) {
    					callback();
    				}
    			});
    		});
    	};
    	
    	this.registerNewUserHandler = function(handler, callback) {
    		othis.register("Bimsie1NotificationInterface", "newUser", handler, function(){
    			othis.call("Bimsie1NotificationRegistryInterface", "registerNewUserHandler", {endPointId: othis.webSocket.endPointId}, function(){
    				if (callback != null) {
    					callback();
    				}
    			});
    		});
    	};

    	this.unregisterNewUserHandler = function(handler, callback) {
    		othis.unregister(handler);
    		othis.call("Bimsie1NotificationRegistryInterface", "unregisterNewUserHandler", {endPointId: othis.webSocket.endPointId}, function(){
    			if (callback != null) {
    				callback();
    			}
    		});
    	};

    	this.unregisterChangeProgressProjectHandler = function(poid, newHandler, closedHandler, callback) {
    		othis.unregister(newHandler);
    		othis.unregister(closedHandler);
    		othis.call("Bimsie1NotificationRegistryInterface", "unregisterChangeProgressOnProject", {poid: poid, endPointId: othis.webSocket.endPointId}, callback);
    	};

    	this.registerChangeProgressProjectHandler = function(poid, newHandler, closedHandler, callback) {
    		othis.register("Bimsie1NotificationInterface", "newProgressOnProjectTopic", newHandler, function(){
    			othis.register("Bimsie1NotificationInterface", "closedProgressOnProjectTopic", closedHandler, function(){
    				othis.call("Bimsie1NotificationRegistryInterface", "registerChangeProgressOnProject", {poid: poid, endPointId: othis.webSocket.endPointId}, function(){
    					if (callback != null) {
    						callback();
    					}
    				});
    			});
    		});
    	}

    	this.unregisterChangeProgressServerHandler = function(newHandler, closedHandler, callback) {
    		othis.unregister(newHandler);
    		othis.unregister(closedHandler);
    		if (othis.webSocket.endPointId != null) {
    			othis.call("Bimsie1NotificationRegistryInterface", "unregisterChangeProgressOnServer", {endPointId: othis.webSocket.endPointId}, callback);
    		}
    	};

    	this.registerChangeProgressServerHandler = function(newHandler, closedHandler, callback) {
    		othis.register("Bimsie1NotificationInterface", "newProgressOnServerTopic", newHandler, function(){
    			othis.register("Bimsie1NotificationInterface", "closedProgressOnServerTopic", closedHandler, function(){
    				othis.call("Bimsie1NotificationRegistryInterface", "registerChangeProgressOnServer", {endPointId: othis.webSocket.endPointId}, function(){
    					if (callback != null) {
    						callback();
    					}
    				});
    			});
    		});
    	}

    	this.unregisterChangeProgressRevisionHandler = function(roid, newHandler, closedHandler, callback) {
    		othis.unregister(newHandler);
    		othis.unregister(closedHandler);
    		othis.call("Bimsie1NotificationRegistryInterface", "unregisterChangeProgressOnProject", {roid: roid, endPointId: othis.webSocket.endPointId}, callback);
    	};

    	this.registerChangeProgressRevisionHandler = function(poid, roid, newHandler, closedHandler, callback) {
    		othis.register("Bimsie1NotificationInterface", "newProgressOnRevisionTopic", newHandler, function(){
    			othis.register("Bimsie1NotificationInterface", "closedProgressOnRevisionTopic", closedHandler, function(){
    				othis.call("Bimsie1NotificationRegistryInterface", "registerChangeProgressOnRevision", {poid: poid, roid: roid, endPointId: othis.webSocket.endPointId}, function(){
    					if (callback != null) {
    						callback();
    					}
    				});
    			});
    		});
    	}

    	this.registerNewProjectHandler = function(handler, callback) {
    		othis.register("Bimsie1NotificationInterface", "newProject", handler, function(){
    			othis.call("Bimsie1NotificationRegistryInterface", "registerNewProjectHandler", {endPointId: othis.webSocket.endPointId}, function(){
    				if (callback != null) {
    					callback();
    				}
    			});
    		});
    	}

    	this.unregisterNewProjectHandler = function(handler, callback){
    		othis.unregister(handler);
    		if (othis.webSocket.endPointId != null) {
    			othis.call("Bimsie1NotificationRegistryInterface", "unregisterNewProjectHandler", {endPointId: othis.webSocket.endPointId}, function(){
    				if (callback != null) {
    					callback();
    				}
    			});
    		}
    	};

    	this.unregisterNewRevisionOnSpecificProjectHandler = function(poid, handler, callback){
    		othis.unregister(handler);
    		othis.call("Bimsie1NotificationRegistryInterface", "unregisterNewRevisionOnSpecificProjectHandler", {endPointId: othis.webSocket.endPointId, poid: poid}, function(){
    			if (callback != null) {
    				callback();
    			}
    		});
    	};

    	this.unregisterNewExtendedDataOnRevisionHandler = function(roid, handler, callback){
    		othis.unregister(handler);
    		othis.call("Bimsie1NotificationRegistryInterface", "unregisterNewExtendedDataOnRevisionHandler", {endPointId: othis.webSocket.endPointId, roid: roid}, function(){
    			if (callback != null) {
    				callback();
    			}
    		});
    	};

    	this.registerProgressHandler = function(topicId, handler, callback){
    		othis.register("Bimsie1NotificationInterface", "progress", handler, function(){
    			othis.call("Bimsie1NotificationRegistryInterface", "registerProgressHandler", {topicId: topicId, endPointId: othis.webSocket.endPointId}, function(){
    				if (callback != null) {
    					callback();
    				} else {
    					othis.call("Bimsie1NotificationRegistryInterface", "getProgress", {
    						topicId: topicId
    					}, function(state){
    						handler(topicId, state);
    					});
    				}
    			});
    		});
    	};

    	this.unregisterProgressHandler = function(topicId, handler, callback){
    		othis.unregister(handler);
    		othis.call("Bimsie1NotificationRegistryInterface", "unregisterProgressHandler", {topicId: topicId, endPointId: othis.webSocket.endPointId}, function(){
    		}).done(callback);
    	};

    	this.unregister = function(listener) {
    		for (var i in othis.listeners) {
    			for (var j in othis.listeners[i]) {
    				var list = othis.listeners[i][j];
    				for (var k=0; k < list.length; k++) {
    					if (list[k] === listener){
    						list.splice(k, 1);
    						return;
    					}
    				}
    			}
    		}
    	};

    	this.createRequest = function(interfaceName, method, data) {
    		var object = {};
    		object["interface"] = interfaceName;
    		object.method = method;
    		object.parameters = data;

    		return object;
    	};
    	
    	this.getJson = function(address, data, success, error){
    		console.log(address);
    		var xhr = new XMLHttpRequest();
    		xhr.open("POST", address);
    		xhr.setRequestHeader("Content-Type", "application/json; charset=UTF-8");
    		xhr.onload = function(jqXHR, textStatus, errorThrown) {
    		    if (xhr.status === 200) {
    		    	try {
    		    		var data = JSON.parse(xhr.responseText);
    		    		success(data);
    		    	} catch (e) {
    		    		if (error != null) {
    		    			error(e);
    		    		} else {
    		    			othis.notifier.setError(e);
    		    			console.error(e);
    		    		}
    		    	}
    		    } else {
    		    	console.log(xhr.status);
    		    	if (error != null) {
    		    		error(jqXHR, textStatus, errorThrown);
    		    	} else {
    		    		othis.notifier.setError(textStatus);
    		    		console.error(jqXHR, textStatus, errorThrown);
    		    	}
    		    }
    		};
    		xhr.send(JSON.stringify(data));
    	};
    	
    	this.multiCall = function(requests, callback, errorCallback, showBusy, showDone, showError) {
    		var promise = new BimServerApiPromise();
    		var request = null;
    		if (requests.length == 1) {
    			request = requests[0];
    			if (othis.interfaceMapping[request[0]] == null) {
    				othis.log("Interface " + request[0] + " not found");
    			}
    			request = {request: othis.createRequest(othis.interfaceMapping[request[0]], request[1], request[2])};
    		} else if (requests.length > 1) {
    			var requestObjects = [];
    			requests.forEach(function(request){
    				requestObjects.push(othis.createRequest(othis.interfaceMapping[request[0]], request[1], request[2]));
    			});
    			request = {
    				requests: requestObjects
    			};
    		} else if (requests.length == 0) {
    			promise.fire();
    			callback();
    		}

//    		othis.notifier.clear();

    		if (othis.token != null) {
    			request.token = othis.token;
    		}

    		var key = requests[0][1];
    		requests.forEach(function(item, index){
    			if (index > 0) {
    				key += "_" + item;
    			}
    		});

    		var showedBusy = false;
    		if (showBusy) {
    			if (othis.lastBusyTimeOut != null) {
    				clearTimeout(othis.lastBusyTimeOut);
    				othis.lastBusyTimeOut = null;
    			}
    			if (typeof window !== 'undefined' && window.setTimeout != null) {
    				othis.lastBusyTimeOut = window.setTimeout(function(){
    					othis.notifier.setInfo(othis.translate(key + "_BUSY"), -1);
    					showedBusy = true;
    				}, 200);
    			}
    		}

//    		othis.notifier.resetStatusQuick();

    		othis.log("request", request);

    		othis.getJson(othis.address, request, function(data) {
				othis.log("response", data);
				var errorsToReport = [];
				if (requests.length == 1) {
					if (showBusy) {
						if (othis.lastBusyTimeOut != null) {
							clearTimeout(othis.lastBusyTimeOut);
						}
					}
					if (data.response.exception != null) {
//    						if (data.response.exception.message == "Invalid token" && !othis.autoLoginTried && $.cookie("username" + window.document.location.port) != null && $.cookie("autologin" + window.document.location.port) != null) {
//    							othis.autologin($.cookie("username" + window.document.location.port), $.cookie("autologin" + window.document.location.port), function(){
//    								othis.log("Trying to connect with autologin");
//    								othis.multiCall(requests, callback, errorCallback);
//    							});
//    						} else {
							if (showError) {
								if (othis.lastTimeOut != null) {
									clearTimeout(othis.lastTimeOut);
								}
								othis.notifier.setError(data.response.exception.message);
							} else {
								if (showedBusy) {
									othis.notifier.resetStatus();
								}
							}
//    						}
					} else {
						if (showDone) {
							othis.notifier.setSuccess(othis.translate(key + "_DONE"), 5000);
						} else {
							if (showedBusy) {
								othis.notifier.resetStatus();
							}
						}
					}
				} else if (requests.length > 1) {
					data.responses.forEach(function(response){
						if (response.exception != null) {
							if (errorCallback == null) {
								othis.notifier.setError(response.exception.message);
							} else {
								errorsToReport.push(response.exception);
							}
						}
					});
				}
				if (errorsToReport.length > 0) {
					errorCallback(errorsToReport);
				} else {
					if (requests.length == 1) {
						callback(data.response);
					} else if (requests.length > 1) {
						callback(data.responses);
					}
				}
				promise.fire();
			},
			function(jqXHR, textStatus, errorThrown){
				if (textStatus == "abort") {
					// ignore
				} else {
					othis.log(errorThrown);
					othis.log(textStatus);
					othis.log(jqXHR);
					if (othis.lastTimeOut != null) {
						clearTimeout(othis.lastTimeOut);
					}
					othis.notifier.setError("ERROR_REMOTE_METHOD_CALL");
				}
				if (callback != null) {
					var result = new Object();
					result.error = textStatus;
					result.ok = false;
					callback(result);
				}
				promise.fire();
			});
    		return promise;
    	};

    	this.getModel = function(poid, roid, schema, deep, callback) {
    		var model = new Model(othis, poid, roid, schema);
    		model.load(deep, callback);
    		return model;
    	};

    	this.createModel = function(poid, callback) {
    		var model = new Model(othis, poid);
    		model.init(callback);
    		return model;
    	};

    	this.callWithNoIndication = function(interfaceName, methodName, data, callback) {
    		return othis.call(interfaceName, methodName, data, callback, null, false, false, false);
    	};

    	this.callWithFullIndication = function(interfaceName, methodName, data, callback) {
    		return othis.call(interfaceName, methodName, data, callback, null, true, true, true);
    	};

    	this.callWithUserErrorIndication = function(action, data, callback) {
    		return othis.call(interfaceName, methodName, data, callback, null, false, false, true);
    	};

    	this.callWithUserErrorAndDoneIndication = function(action, data, callback) {
    		return othis.call(interfaceName, methodName, data, callback, null, false, true, true);
    	};

    	this.isA = function(schema, typeSubject, typeName){
    		var isa = false;
    		if (typeSubject == typeName) {
    			return true;
    		}
    		var subject = othis.schemas[schema][typeSubject];
    		if (subject == null) {
    			console.log(typeSubject, "not found");
    		}
    		subject.superclasses.some(function(superclass){
    			if (superclass == typeName) {
    				isa = true;
    				return true;
    			}
    			if (othis.isA(schema, superclass, typeName)) {
    				isa = true;
    				return true;
    			}
    			return false;
    		});
    		return isa;
    	};

    	this.initiateCheckin = function(project, deserializerOid, callback){
    		othis.call("ServiceInterface", "initiateCheckin", {
    			deserializerOid: deserializerOid,
    			poid: project.oid
    		}, function(topicId){
    			if (callback != null) {
    				callback(topicId);
    			}
    		});
    	};
    	
    	this.checkin = function(topicId, project, comment, file, deserializerOid, progressListener, success, error){
    		var xhr = new XMLHttpRequest();
    		
    		xhr.upload.addEventListener("progress",
    			function(e) {
    				if (e.lengthComputable) {
    					var percentage = Math.round((e.loaded * 100) / e.total);
    					progressListener(percentage);
    				}
    			}, false);

    		xhr.addEventListener("load", function(e) {
    			var result = JSON.parse(this.response);
    			
    			if (result.exception == null) {
    				if (success != null) {
    					success(result.checkinid);
    				}
    			} else {
    				if (error == null) {
    					console.error(result.exception);
    				} else {
    					error(result.exception);
    				}
    			}
    		}, false);
    		xhr.open("POST", Global.bimServerApi.baseUrl + "/upload");

    		var formData = new FormData();
			formData.append("token", othis.token);
			formData.append("deserializerOid", deserializerOid);
			formData.append("comment", comment);
			formData.append("poid", project.oid);
			formData.append("topicId", topicId);
			formData.append("file", file);

			xhr.send(formData);
    	};

    	this.addExtendedData = function(roid, file, success, error){
    		var reader = new FileReader();
    		var xhr = new XMLHttpRequest();
    		
    		xhr.addEventListener("load", function(e) {
    			var result = JSON.parse(this.response);
    			
    			if (result.exception == null) {
    				Global.bimServerApi.call("Bimsie1ServiceInterface", "addExtendedDataToRevision", {
    					roid: roid,
    					extendedData: {
    						__type: "SExtendedData",
    						title: $(".addextendeddata .title").val(),
    						schemaId: $(".addextendeddata .schemaSelect").val(),
    						fileId: result.fileId
    					}
    				}, function(){
	    				success(result.checkinid);
    				});
    			} else {
    				error(result.exception);
    			}
    		}, false);
    		xhr.open("POST", Global.bimServerApi.baseUrl + "/upload");
    		reader.onload = function(evt) {
    			var formData = new FormData();
    			formData.append("action", "file");
    			formData.append("token", othis.token);
    			formData.append("file", file);
    			
    			xhr.send(formData);
    		};
    		reader.readAsBinaryString(file);
    	};
    	
    	this.setToken = function(token, callback, errorCallback) {
    		othis.token = token;
    		othis.call("AuthInterface", "getLoggedInUser", {}, function(data){
    			othis.user = data;
    			othis.webSocket.connect(callback);
    		}, function(){
    			if (errorCallback != null) {
    				errorCallback();
    			}
    		});
    	};

    	/**
    	 * Call a single method, this method delegates to the multiCall method
    	 * @param {string} interfaceName - Interface name, e.g. "Bimsie1ServiceInterface"
    	 * @param {string} methodName - Methodname, e.g. "addProject"
    	 * @param {Object} data - Object with a field per arument
    	 * @param {Function} callback - Function to callback, first argument in callback will be the returned object
    	 * @param {Function} errorCallback - Function to callback on error
    	 * @param {boolean} showBusy - Whether to show busy indication
    	 * @param {boolean} showDone - Whether to show done indication
    	 * @param {boolean} showError - Whether to show errors
    	 * 
    	 */
    	this.call = function(interfaceName, methodName, data, callback, errorCallback, showBusy, showDone, showError) {
    		var showBusy = typeof showBusy !== 'undefined' ? showBusy : true;
    		var showDone = typeof showDone !== 'undefined' ? showDone : false;
    		var showError = typeof showError !== 'undefined' ? showError : true;

    		return othis.multiCall([[
    		    interfaceName,
    		    methodName,
    			data
    		]], function(data){
    			if (data.exception == null) {
    				if (callback != null) {
    					callback(data.result);
    				}
    			} else {
    				if (errorCallback != null) {
    					errorCallback(data.exception);
    				}
    			}
    		}, errorCallback, showBusy, showDone, showError);
    	};

    	othis.webSocket.listener = othis.processNotification;
    };
});
define(function(){
	return function(counter){
		var o = this;
		
		o.isDone = false;
		o.chains = [];
		o.callback = null;
		o.counter = counter;

		this.done = function(callback){
			if (o.isDone) {
				callback();
			} else {
				if (o.callback != null) {
					if (o.callback instanceof Array) {
						o.callback.push(callback);
					} else {
						o.callback = [o.callback, callback];
					}
				} else {
					o.callback = callback;
				}
			}
			return o;
		};
		
		this.inc = function(){
			if (o.counter == null) {
				o.counter = 0;
			}
			o.counter++;
		};

		this.dec = function(){
			if (o.counter == null) {
				o.counter = 0;
			}
			o.counter--;
			if (o.counter == 0) {
				o.done = true;
				o.fire();
			}
		};

		this.fire = function(){
			if (o.isDone) {
				console.log("Promise already fired, not triggering again...");
				return;
			}
			o.isDone = true;
			if (o.callback != null) {
				if (o.callback instanceof Array) {
					o.callback.forEach(function(cb){
						cb();
					});
				} else {
					o.callback();
				}
			}
		};
		
		this.chain = function(otherPromise) {
			var promises;
			if (otherPromise instanceof Array) {
				promises = otherPromise;
			} else {
				promises = [otherPromise];
			}
			promises.forEach(function(promise){
				if (!promise.isDone) {
					o.chains.push(promise);
					promise.done(function(){
						for (var i=o.chains.length-1; i>=0; i--) {
							if (o.chains[i] == promise) {
								o.chains.splice(i, 1);
							}
						}
						if (o.chains.length == 0) {
							o.fire();
						}
					});
				}
			});
			if (o.chains.length == 0) {
				o.fire();
			}
		};
	};
});

define([], function(){
	return function(baseUrl, bimServerApi) {
		var othis = this;
		this.connected = false;
		this.openCallbacks = [];
		this.endPointId = null;
		this.listener = null;
		this.tosend = [];
		this.tosendAfterConnect = [];
		this.messagesReceived = 0;
		this.intervalId = null;
	
		this.connect = function(callback) {
			if (callback != null && typeof callback === "function") {
				othis.openCallbacks.push(callback);
			} else {
				console.error("Callback was not a function", callback);
			}
			var location = bimServerApi.baseUrl.toString().replace('http://', 'ws://').replace('https://', 'wss://') + "/stream";
			if ("WebSocket" in window) {
				try {
					this._ws = new WebSocket(location);
					this._ws.binaryType = "arraybuffer";
					this._ws.onopen = this._onopen;
					this._ws.onmessage = this._onmessage;
					this._ws.onclose = this._onclose;
					this._ws.onerror = this._onerror;
				} catch (err) {
					bimServerApi.notifier.setError("WebSocket error" + (err.message != null ? (": " + err.message) : ""));
				}
			} else {
				bimServerApi.notifier.setError("This browser does not support websockets <a href=\"https://github.com/opensourceBIM/bimvie.ws/wiki/Requirements\"></a>");
			}
		};
	
		this._onerror = function(err) {
			console.log(err);
			bimServerApi.notifier.setError("WebSocket error" + (err.message != null ? (": " + err.message) : ""));
		};
	
		this._onopen = function() {
			othis.intervalId = window.setInterval(function(){
				othis.send({"hb": true});
			}, 30 * 1000); // Send hb every 30 seconds
			while (othis.tosendAfterConnect.length > 0 && othis._ws.readyState == 1) {
				var messageArray = othis.tosendAfterConnect.splice(0, 1);
				othis._sendWithoutEndPoint(messageArray[0]);
			}
		};
	
		this._sendWithoutEndPoint = function(message) {
			if (othis._ws && othis._ws.readyState == 1) {
				othis._ws.send(message);
			} else {
				othis.tosendAfterConnect.push(message);
			}		
		};
		
		this._send = function(message) {
			if (othis._ws && othis._ws.readyState == 1 && othis.endPointId != null) {
				othis._ws.send(message);
			} else {
				console.log("Waiting", message);
				othis.tosend.push(message);
			}
		};
	
		this.send = function(object) {
			var str = JSON.stringify(object);
			bimServerApi.log("Sending", str);
			othis._send(str);
		};
	
		this._onmessage = function(message) {
			othis.messagesReceived++;
			if (othis.messagesReceived % 10 == 0) {
	//			console.log(othis.messagesReceived);
			}
			if (message.data instanceof ArrayBuffer) {
				othis.listener(message.data);
			} else {
				var incomingMessage = JSON.parse(message.data);
				bimServerApi.log("incoming", incomingMessage);
				if (incomingMessage.welcome != null) {
					othis._sendWithoutEndPoint(JSON.stringify({"token": bimServerApi.token}));
				} else if (incomingMessage.endpointid != null) {
					othis.endPointId = incomingMessage.endpointid;
					othis.connected = true;
					othis.openCallbacks.forEach(function(callback){
						callback();
					});
					while (othis.tosend.length > 0 && othis._ws.readyState == 1) {
						var messageArray = othis.tosend.splice(0, 1);
						console.log(messageArray[0]);
						othis._send(messageArray[0]);
					}
					othis.openCallbacks = [];
				} else {
					if (incomingMessage.request != null) {
						othis.listener(incomingMessage.request);
					} else if (incomingMessage.requests != null) {
						incomingMessage.requests.forEach(function(request){
							othis.listener(request);
						});
					}
				}
			}
		};
	
		this._onclose = function(m) {
			console.log("WebSocket closed");
			window.clearInterval(othis.intervalId);
			othis._ws = null;
			othis.connected = false;
			othis.openCallbacks = [];
			othis.endpointid = null;
		};
	}
});
define(function(){
	return {
	  "classes": {
	    "Tristate": {},
	    "Ifc2DCompositeCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCompositeCurve"
	      ],
	      "fields": {}
	    },
	    "IfcActionRequest": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "RequestID": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcActor": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObject"
	      ],
	      "fields": {
	        "TheActor": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "IsActingUpon": {
	          "type": "IfcRelAssignsToActor",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcActorRole": {
	      "domain": "ifcactorresource",
	      "superclasses": [],
	      "fields": {
	        "Role": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedRole": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcActuatorType": {
	      "domain": "ifcbuildingcontrolsdomain",
	      "superclasses": [
	        "IfcDistributionControlElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAddress": {
	      "domain": "ifcactorresource",
	      "superclasses": [
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Purpose": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedPurpose": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "OfPerson": {
	          "type": "IfcPerson",
	          "reference": true,
	          "many": true
	        },
	        "OfOrganization": {
	          "type": "IfcOrganization",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcAirTerminalBoxType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowControllerType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAirTerminalType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAirToAirHeatRecoveryType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAlarmType": {
	      "domain": "ifcbuildingcontrolsdomain",
	      "superclasses": [
	        "IfcDistributionControlElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAngularDimension": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcDimensionCurveDirectedCallout"
	      ],
	      "fields": {}
	    },
	    "IfcAnnotation": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcProduct"
	      ],
	      "fields": {
	        "ContainedInStructure": {
	          "type": "IfcRelContainedInSpatialStructure",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcAnnotationCurveOccurrence": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcAnnotationOccurrence",
	        "IfcDraughtingCalloutElement"
	      ],
	      "fields": {}
	    },
	    "IfcAnnotationFillArea": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "OuterBoundary": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "InnerBoundaries": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcAnnotationFillAreaOccurrence": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcAnnotationOccurrence"
	      ],
	      "fields": {
	        "FillStyleTarget": {
	          "type": "IfcPoint",
	          "reference": true,
	          "many": false
	        },
	        "GlobalOrLocal": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAnnotationOccurrence": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcStyledItem"
	      ],
	      "fields": {}
	    },
	    "IfcAnnotationSurface": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Item": {
	          "type": "IfcGeometricRepresentationItem",
	          "reference": true,
	          "many": false
	        },
	        "TextureCoordinates": {
	          "type": "IfcTextureCoordinate",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcAnnotationSurfaceOccurrence": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcAnnotationOccurrence"
	      ],
	      "fields": {}
	    },
	    "IfcAnnotationSymbolOccurrence": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcAnnotationOccurrence",
	        "IfcDraughtingCalloutElement"
	      ],
	      "fields": {}
	    },
	    "IfcAnnotationTextOccurrence": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcAnnotationOccurrence",
	        "IfcDraughtingCalloutElement"
	      ],
	      "fields": {}
	    },
	    "IfcApplication": {
	      "domain": "ifcutilityresource",
	      "superclasses": [],
	      "fields": {
	        "ApplicationDeveloper": {
	          "type": "IfcOrganization",
	          "reference": true,
	          "many": false
	        },
	        "Version": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ApplicationFullName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ApplicationIdentifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAppliedValue": {
	      "domain": "ifccostresource",
	      "superclasses": [
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AppliedValue": {
	          "type": "IfcAppliedValueSelect",
	          "reference": true,
	          "many": false
	        },
	        "UnitBasis": {
	          "type": "IfcMeasureWithUnit",
	          "reference": true,
	          "many": false
	        },
	        "ApplicableDate": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "FixedUntilDate": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "ValuesReferenced": {
	          "type": "IfcReferencesValueDocument",
	          "reference": true,
	          "many": true
	        },
	        "ValueOfComponents": {
	          "type": "IfcAppliedValueRelationship",
	          "reference": true,
	          "many": true
	        },
	        "IsComponentIn": {
	          "type": "IfcAppliedValueRelationship",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcAppliedValueRelationship": {
	      "domain": "ifccostresource",
	      "superclasses": [],
	      "fields": {
	        "ComponentOfTotal": {
	          "type": "IfcAppliedValue",
	          "reference": true,
	          "many": false
	        },
	        "Components": {
	          "type": "IfcAppliedValue",
	          "reference": true,
	          "many": true
	        },
	        "ArithmeticOperator": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcApproval": {
	      "domain": "ifcapprovalresource",
	      "superclasses": [],
	      "fields": {
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ApprovalDateTime": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "ApprovalStatus": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ApprovalLevel": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ApprovalQualifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Identifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Actors": {
	          "type": "IfcApprovalActorRelationship",
	          "reference": true,
	          "many": true
	        },
	        "IsRelatedWith": {
	          "type": "IfcApprovalRelationship",
	          "reference": true,
	          "many": true
	        },
	        "Relates": {
	          "type": "IfcApprovalRelationship",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcApprovalActorRelationship": {
	      "domain": "ifcapprovalresource",
	      "superclasses": [],
	      "fields": {
	        "Actor": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "Approval": {
	          "type": "IfcApproval",
	          "reference": true,
	          "many": false
	        },
	        "Role": {
	          "type": "IfcActorRole",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcApprovalPropertyRelationship": {
	      "domain": "ifcapprovalresource",
	      "superclasses": [],
	      "fields": {
	        "ApprovedProperties": {
	          "type": "IfcProperty",
	          "reference": true,
	          "many": true
	        },
	        "Approval": {
	          "type": "IfcApproval",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcApprovalRelationship": {
	      "domain": "ifcapprovalresource",
	      "superclasses": [],
	      "fields": {
	        "RelatedApproval": {
	          "type": "IfcApproval",
	          "reference": true,
	          "many": false
	        },
	        "RelatingApproval": {
	          "type": "IfcApproval",
	          "reference": true,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcArbitraryClosedProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcProfileDef"
	      ],
	      "fields": {
	        "OuterCurve": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcArbitraryOpenProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcProfileDef"
	      ],
	      "fields": {
	        "Curve": {
	          "type": "IfcBoundedCurve",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcArbitraryProfileDefWithVoids": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcArbitraryClosedProfileDef"
	      ],
	      "fields": {
	        "InnerCurves": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcAsset": {
	      "domain": "ifcsharedfacilitieselements",
	      "superclasses": [
	        "IfcGroup"
	      ],
	      "fields": {
	        "AssetID": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "OriginalValue": {
	          "type": "IfcCostValue",
	          "reference": true,
	          "many": false
	        },
	        "CurrentValue": {
	          "type": "IfcCostValue",
	          "reference": true,
	          "many": false
	        },
	        "TotalReplacementCost": {
	          "type": "IfcCostValue",
	          "reference": true,
	          "many": false
	        },
	        "Owner": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "User": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "ResponsiblePerson": {
	          "type": "IfcPerson",
	          "reference": true,
	          "many": false
	        },
	        "IncorporationDate": {
	          "type": "IfcCalendarDate",
	          "reference": true,
	          "many": false
	        },
	        "DepreciatedValue": {
	          "type": "IfcCostValue",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcAsymmetricIShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcIShapeProfileDef"
	      ],
	      "fields": {
	        "TopFlangeWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TopFlangeWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TopFlangeThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TopFlangeThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TopFlangeFilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TopFlangeFilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAxis1Placement": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcPlacement"
	      ],
	      "fields": {
	        "Axis": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcAxis2Placement2D": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcPlacement",
	        "IfcAxis2Placement"
	      ],
	      "fields": {
	        "RefDirection": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcAxis2Placement3D": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcPlacement",
	        "IfcAxis2Placement"
	      ],
	      "fields": {
	        "Axis": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        },
	        "RefDirection": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcBSplineCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcBoundedCurve"
	      ],
	      "fields": {
	        "Degree": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "ControlPointsList": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": true
	        },
	        "CurveForm": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ClosedCurve": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        },
	        "SelfIntersect": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBeam": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {}
	    },
	    "IfcBeamType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBezierCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcBSplineCurve"
	      ],
	      "fields": {}
	    },
	    "IfcBlobTexture": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSurfaceTexture"
	      ],
	      "fields": {
	        "RasterFormat": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RasterCode": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBlock": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcCsgPrimitive3D"
	      ],
	      "fields": {
	        "XLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "XLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "YLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "YLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ZLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ZLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoilerType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBooleanClippingResult": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcBooleanResult"
	      ],
	      "fields": {}
	    },
	    "IfcBooleanResult": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcBooleanOperand",
	        "IfcCsgSelect"
	      ],
	      "fields": {
	        "Operator": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "FirstOperand": {
	          "type": "IfcBooleanOperand",
	          "reference": true,
	          "many": false
	        },
	        "SecondOperand": {
	          "type": "IfcBooleanOperand",
	          "reference": true,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoundaryCondition": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoundaryEdgeCondition": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcBoundaryCondition"
	      ],
	      "fields": {
	        "LinearStiffnessByLengthX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByLengthXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByLengthY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByLengthYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByLengthZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByLengthZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessByLengthX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessByLengthXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessByLengthY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessByLengthYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessByLengthZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessByLengthZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoundaryFaceCondition": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcBoundaryCondition"
	      ],
	      "fields": {
	        "LinearStiffnessByAreaX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByAreaXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByAreaY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByAreaYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByAreaZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessByAreaZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoundaryNodeCondition": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcBoundaryCondition"
	      ],
	      "fields": {
	        "LinearStiffnessX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearStiffnessZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalStiffnessZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoundaryNodeConditionWarping": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcBoundaryNodeCondition"
	      ],
	      "fields": {
	        "WarpingStiffness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WarpingStiffnessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoundedCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCurve",
	        "IfcCurveOrEdgeCurve"
	      ],
	      "fields": {}
	    },
	    "IfcBoundedSurface": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcSurface"
	      ],
	      "fields": {}
	    },
	    "IfcBoundingBox": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Corner": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": false
	        },
	        "XDim": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "XDimAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "YDim": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "YDimAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ZDim": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ZDimAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoxedHalfSpace": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcHalfSpaceSolid"
	      ],
	      "fields": {
	        "Enclosure": {
	          "type": "IfcBoundingBox",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcBuilding": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcSpatialStructureElement"
	      ],
	      "fields": {
	        "ElevationOfRefHeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ElevationOfRefHeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ElevationOfTerrain": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ElevationOfTerrainAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BuildingAddress": {
	          "type": "IfcPostalAddress",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcBuildingElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {}
	    },
	    "IfcBuildingElementComponent": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {}
	    },
	    "IfcBuildingElementPart": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcBuildingElementComponent"
	      ],
	      "fields": {}
	    },
	    "IfcBuildingElementProxy": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "CompositionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBuildingElementProxyType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBuildingElementType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElementType"
	      ],
	      "fields": {}
	    },
	    "IfcBuildingStorey": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcSpatialStructureElement"
	      ],
	      "fields": {
	        "Elevation": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ElevationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "Depth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Width": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WallThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WallThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Girth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "GirthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "InternalFilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "InternalFilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCableCarrierFittingType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowFittingType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCableCarrierSegmentType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowSegmentType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCableSegmentType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowSegmentType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCalendarDate": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [
	        "IfcDateTimeSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "DayComponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "MonthComponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "YearComponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCartesianPoint": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcPoint",
	        "IfcTrimmingSelect"
	      ],
	      "fields": {
	        "Coordinates": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "CoordinatesAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCartesianTransformationOperator": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Axis1": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        },
	        "Axis2": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        },
	        "LocalOrigin": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": false
	        },
	        "Scale": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ScaleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCartesianTransformationOperator2D": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCartesianTransformationOperator"
	      ],
	      "fields": {}
	    },
	    "IfcCartesianTransformationOperator2DnonUniform": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCartesianTransformationOperator2D"
	      ],
	      "fields": {
	        "Scale2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "Scale2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCartesianTransformationOperator3D": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCartesianTransformationOperator"
	      ],
	      "fields": {
	        "Axis3": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcCartesianTransformationOperator3DnonUniform": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCartesianTransformationOperator3D"
	      ],
	      "fields": {
	        "Scale2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "Scale2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Scale3": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "Scale3AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCenterLineProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcArbitraryOpenProfileDef"
	      ],
	      "fields": {
	        "Thickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcChamferEdgeFeature": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcEdgeFeature"
	      ],
	      "fields": {
	        "Width": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Height": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcChillerType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCircle": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcConic"
	      ],
	      "fields": {
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCircleHollowProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcCircleProfileDef"
	      ],
	      "fields": {
	        "WallThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WallThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCircleProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcClassification": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {
	        "Source": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Edition": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EditionDate": {
	          "type": "IfcCalendarDate",
	          "reference": true,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Contains": {
	          "type": "IfcClassificationItem",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcClassificationItem": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {
	        "Notation": {
	          "type": "IfcClassificationNotationFacet",
	          "reference": true,
	          "many": false
	        },
	        "ItemOf": {
	          "type": "IfcClassification",
	          "reference": true,
	          "many": false
	        },
	        "Title": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "IsClassifiedItemIn": {
	          "type": "IfcClassificationItemRelationship",
	          "reference": true,
	          "many": true
	        },
	        "IsClassifyingItemIn": {
	          "type": "IfcClassificationItemRelationship",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcClassificationItemRelationship": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {
	        "RelatingItem": {
	          "type": "IfcClassificationItem",
	          "reference": true,
	          "many": false
	        },
	        "RelatedItems": {
	          "type": "IfcClassificationItem",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcClassificationNotation": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [
	        "IfcClassificationNotationSelect"
	      ],
	      "fields": {
	        "NotationFacets": {
	          "type": "IfcClassificationNotationFacet",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcClassificationNotationFacet": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {
	        "NotationValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcClassificationReference": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [
	        "IfcExternalReference",
	        "IfcClassificationNotationSelect"
	      ],
	      "fields": {
	        "ReferencedSource": {
	          "type": "IfcClassification",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcClosedShell": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcConnectedFaceSet",
	        "IfcShell"
	      ],
	      "fields": {}
	    },
	    "IfcCoilType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcColourRgb": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcColourSpecification",
	        "IfcColourOrFactor"
	      ],
	      "fields": {
	        "Red": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RedAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Green": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "GreenAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Blue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BlueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcColourSpecification": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcColour"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcColumn": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {}
	    },
	    "IfcColumnType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcComplexProperty": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [
	        "IfcProperty"
	      ],
	      "fields": {
	        "UsageName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HasProperties": {
	          "type": "IfcProperty",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcCompositeCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcBoundedCurve"
	      ],
	      "fields": {
	        "Segments": {
	          "type": "IfcCompositeCurveSegment",
	          "reference": true,
	          "many": true
	        },
	        "SelfIntersect": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCompositeCurveSegment": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Transition": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "SameSense": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ParentCurve": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "UsingCurves": {
	          "type": "IfcCompositeCurve",
	          "reference": true,
	          "many": true
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCompositeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcProfileDef"
	      ],
	      "fields": {
	        "Profiles": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": true
	        },
	        "Label": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCompressorType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowMovingDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCondenserType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCondition": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [
	        "IfcGroup"
	      ],
	      "fields": {}
	    },
	    "IfcConditionCriterion": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "Criterion": {
	          "type": "IfcConditionCriterionSelect",
	          "reference": true,
	          "many": false
	        },
	        "CriterionDateTime": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcConic": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCurve"
	      ],
	      "fields": {
	        "Position": {
	          "type": "IfcAxis2Placement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcConnectedFaceSet": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcTopologicalRepresentationItem"
	      ],
	      "fields": {
	        "CfsFaces": {
	          "type": "IfcFace",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcConnectionCurveGeometry": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [
	        "IfcConnectionGeometry"
	      ],
	      "fields": {
	        "CurveOnRelatingElement": {
	          "type": "IfcCurveOrEdgeCurve",
	          "reference": true,
	          "many": false
	        },
	        "CurveOnRelatedElement": {
	          "type": "IfcCurveOrEdgeCurve",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcConnectionGeometry": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcConnectionPointEccentricity": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [
	        "IfcConnectionPointGeometry"
	      ],
	      "fields": {
	        "EccentricityInX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EccentricityInXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EccentricityInY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EccentricityInYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EccentricityInZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EccentricityInZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcConnectionPointGeometry": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [
	        "IfcConnectionGeometry"
	      ],
	      "fields": {
	        "PointOnRelatingElement": {
	          "type": "IfcPointOrVertexPoint",
	          "reference": true,
	          "many": false
	        },
	        "PointOnRelatedElement": {
	          "type": "IfcPointOrVertexPoint",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcConnectionPortGeometry": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [
	        "IfcConnectionGeometry"
	      ],
	      "fields": {
	        "LocationAtRelatingElement": {
	          "type": "IfcAxis2Placement",
	          "reference": true,
	          "many": false
	        },
	        "LocationAtRelatedElement": {
	          "type": "IfcAxis2Placement",
	          "reference": true,
	          "many": false
	        },
	        "ProfileOfPort": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcConnectionSurfaceGeometry": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [
	        "IfcConnectionGeometry"
	      ],
	      "fields": {
	        "SurfaceOnRelatingElement": {
	          "type": "IfcSurfaceOrFaceSurface",
	          "reference": true,
	          "many": false
	        },
	        "SurfaceOnRelatedElement": {
	          "type": "IfcSurfaceOrFaceSurface",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcConstraint": {
	      "domain": "ifcconstraintresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ConstraintGrade": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ConstraintSource": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CreatingActor": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "CreationTime": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "UserDefinedGrade": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ClassifiedAs": {
	          "type": "IfcConstraintClassificationRelationship",
	          "reference": true,
	          "many": true
	        },
	        "RelatesConstraints": {
	          "type": "IfcConstraintRelationship",
	          "reference": true,
	          "many": true
	        },
	        "IsRelatedWith": {
	          "type": "IfcConstraintRelationship",
	          "reference": true,
	          "many": true
	        },
	        "PropertiesForConstraint": {
	          "type": "IfcPropertyConstraintRelationship",
	          "reference": true,
	          "many": true
	        },
	        "Aggregates": {
	          "type": "IfcConstraintAggregationRelationship",
	          "reference": true,
	          "many": true
	        },
	        "IsAggregatedIn": {
	          "type": "IfcConstraintAggregationRelationship",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcConstraintAggregationRelationship": {
	      "domain": "ifcconstraintresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RelatingConstraint": {
	          "type": "IfcConstraint",
	          "reference": true,
	          "many": false
	        },
	        "RelatedConstraints": {
	          "type": "IfcConstraint",
	          "reference": true,
	          "many": true
	        },
	        "LogicalAggregator": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcConstraintClassificationRelationship": {
	      "domain": "ifcconstraintresource",
	      "superclasses": [],
	      "fields": {
	        "ClassifiedConstraint": {
	          "type": "IfcConstraint",
	          "reference": true,
	          "many": false
	        },
	        "RelatedClassifications": {
	          "type": "IfcClassificationNotationSelect",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcConstraintRelationship": {
	      "domain": "ifcconstraintresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RelatingConstraint": {
	          "type": "IfcConstraint",
	          "reference": true,
	          "many": false
	        },
	        "RelatedConstraints": {
	          "type": "IfcConstraint",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcConstructionEquipmentResource": {
	      "domain": "ifcconstructionmgmtdomain",
	      "superclasses": [
	        "IfcConstructionResource"
	      ],
	      "fields": {}
	    },
	    "IfcConstructionMaterialResource": {
	      "domain": "ifcconstructionmgmtdomain",
	      "superclasses": [
	        "IfcConstructionResource"
	      ],
	      "fields": {
	        "Suppliers": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": true
	        },
	        "UsageRatio": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "UsageRatioAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcConstructionProductResource": {
	      "domain": "ifcconstructionmgmtdomain",
	      "superclasses": [
	        "IfcConstructionResource"
	      ],
	      "fields": {}
	    },
	    "IfcConstructionResource": {
	      "domain": "ifcconstructionmgmtdomain",
	      "superclasses": [
	        "IfcResource"
	      ],
	      "fields": {
	        "ResourceIdentifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ResourceGroup": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ResourceConsumption": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "BaseQuantity": {
	          "type": "IfcMeasureWithUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcContextDependentUnit": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcNamedUnit"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcControl": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObject"
	      ],
	      "fields": {
	        "Controls": {
	          "type": "IfcRelAssignsToControl",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcControllerType": {
	      "domain": "ifcbuildingcontrolsdomain",
	      "superclasses": [
	        "IfcDistributionControlElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcConversionBasedUnit": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcNamedUnit"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ConversionFactor": {
	          "type": "IfcMeasureWithUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcCooledBeamType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCoolingTowerType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCoordinatedUniversalTimeOffset": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [],
	      "fields": {
	        "HourOffset": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "MinuteOffset": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "Sense": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCostItem": {
	      "domain": "ifcsharedmgmtelements",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {}
	    },
	    "IfcCostSchedule": {
	      "domain": "ifcsharedmgmtelements",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "SubmittedBy": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "PreparedBy": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "SubmittedOn": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "Status": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TargetUsers": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": true
	        },
	        "UpdateDate": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "ID": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCostValue": {
	      "domain": "ifccostresource",
	      "superclasses": [
	        "IfcAppliedValue",
	        "IfcMetricValueSelect"
	      ],
	      "fields": {
	        "CostType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Condition": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCovering": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "CoversSpaces": {
	          "type": "IfcRelCoversSpaces",
	          "reference": true,
	          "many": true
	        },
	        "Covers": {
	          "type": "IfcRelCoversBldgElements",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcCoveringType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCraneRailAShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "OverallHeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OverallHeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BaseWidth2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BaseWidth2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HeadWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeadWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HeadDepth2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeadDepth2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HeadDepth3": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeadDepth3AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WebThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WebThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BaseWidth4": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BaseWidth4AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth1": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth1AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth3": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth3AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCraneRailFShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "OverallHeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OverallHeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HeadWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeadWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HeadDepth2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeadDepth2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HeadDepth3": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeadDepth3AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WebThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WebThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth1": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth1AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BaseDepth2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCrewResource": {
	      "domain": "ifcconstructionmgmtdomain",
	      "superclasses": [
	        "IfcConstructionResource"
	      ],
	      "fields": {}
	    },
	    "IfcCsgPrimitive3D": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcBooleanOperand",
	        "IfcCsgSelect"
	      ],
	      "fields": {
	        "Position": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCsgSolid": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcSolidModel"
	      ],
	      "fields": {
	        "TreeRootExpression": {
	          "type": "IfcCsgSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcCurrencyRelationship": {
	      "domain": "ifccostresource",
	      "superclasses": [],
	      "fields": {
	        "RelatingMonetaryUnit": {
	          "type": "IfcMonetaryUnit",
	          "reference": true,
	          "many": false
	        },
	        "RelatedMonetaryUnit": {
	          "type": "IfcMonetaryUnit",
	          "reference": true,
	          "many": false
	        },
	        "ExchangeRate": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ExchangeRateAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RateDateTime": {
	          "type": "IfcDateAndTime",
	          "reference": true,
	          "many": false
	        },
	        "RateSource": {
	          "type": "IfcLibraryInformation",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcCurtainWall": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {}
	    },
	    "IfcCurtainWallType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcGeometricSetSelect"
	      ],
	      "fields": {
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCurveBoundedPlane": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcBoundedSurface"
	      ],
	      "fields": {
	        "BasisSurface": {
	          "type": "IfcPlane",
	          "reference": true,
	          "many": false
	        },
	        "OuterBoundary": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "InnerBoundaries": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": true
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCurveStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcPresentationStyle",
	        "IfcPresentationStyleSelect"
	      ],
	      "fields": {
	        "CurveFont": {
	          "type": "IfcCurveFontOrScaledCurveFontSelect",
	          "reference": true,
	          "many": false
	        },
	        "CurveWidth": {
	          "type": "IfcSizeSelect",
	          "reference": true,
	          "many": false
	        },
	        "CurveColour": {
	          "type": "IfcColour",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcCurveStyleFont": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcCurveStyleFontSelect"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PatternList": {
	          "type": "IfcCurveStyleFontPattern",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcCurveStyleFontAndScaling": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcCurveFontOrScaledCurveFontSelect"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CurveFont": {
	          "type": "IfcCurveStyleFontSelect",
	          "reference": true,
	          "many": false
	        },
	        "CurveFontScaling": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CurveFontScalingAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCurveStyleFontPattern": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {
	        "VisibleSegmentLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "VisibleSegmentLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "InvisibleSegmentLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "InvisibleSegmentLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDamperType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowControllerType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDateAndTime": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [
	        "IfcDateTimeSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "DateComponent": {
	          "type": "IfcCalendarDate",
	          "reference": true,
	          "many": false
	        },
	        "TimeComponent": {
	          "type": "IfcLocalTime",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcDefinedSymbol": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Definition": {
	          "type": "IfcDefinedSymbolSelect",
	          "reference": true,
	          "many": false
	        },
	        "Target": {
	          "type": "IfcCartesianTransformationOperator2D",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcDerivedProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcProfileDef"
	      ],
	      "fields": {
	        "ParentProfile": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": false
	        },
	        "Operator": {
	          "type": "IfcCartesianTransformationOperator2D",
	          "reference": true,
	          "many": false
	        },
	        "Label": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDerivedUnit": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcUnit"
	      ],
	      "fields": {
	        "Elements": {
	          "type": "IfcDerivedUnitElement",
	          "reference": true,
	          "many": true
	        },
	        "UnitType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDerivedUnitElement": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [],
	      "fields": {
	        "Unit": {
	          "type": "IfcNamedUnit",
	          "reference": true,
	          "many": false
	        },
	        "Exponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDiameterDimension": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcDimensionCurveDirectedCallout"
	      ],
	      "fields": {}
	    },
	    "IfcDimensionCalloutRelationship": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcDraughtingCalloutRelationship"
	      ],
	      "fields": {}
	    },
	    "IfcDimensionCurve": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcAnnotationCurveOccurrence"
	      ],
	      "fields": {
	        "AnnotatedBySymbols": {
	          "type": "IfcTerminatorSymbol",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcDimensionCurveDirectedCallout": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcDraughtingCallout"
	      ],
	      "fields": {}
	    },
	    "IfcDimensionCurveTerminator": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcTerminatorSymbol"
	      ],
	      "fields": {
	        "Role": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDimensionPair": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcDraughtingCalloutRelationship"
	      ],
	      "fields": {}
	    },
	    "IfcDimensionalExponents": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [],
	      "fields": {
	        "LengthExponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "MassExponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "TimeExponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "ElectricCurrentExponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "ThermodynamicTemperatureExponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "AmountOfSubstanceExponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "LuminousIntensityExponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDirection": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcOrientationSelect",
	        "IfcVectorOrDirection"
	      ],
	      "fields": {
	        "DirectionRatios": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "DirectionRatiosAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDiscreteAccessory": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcElementComponent"
	      ],
	      "fields": {}
	    },
	    "IfcDiscreteAccessoryType": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcElementComponentType"
	      ],
	      "fields": {}
	    },
	    "IfcDistributionChamberElement": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcDistributionChamberElementType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDistributionControlElement": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionElement"
	      ],
	      "fields": {
	        "ControlElementId": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AssignedToFlowElement": {
	          "type": "IfcRelFlowControlElements",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcDistributionControlElementType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionElementType"
	      ],
	      "fields": {}
	    },
	    "IfcDistributionElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {}
	    },
	    "IfcDistributionElementType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElementType"
	      ],
	      "fields": {}
	    },
	    "IfcDistributionFlowElement": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionElement"
	      ],
	      "fields": {
	        "HasControlElements": {
	          "type": "IfcRelFlowControlElements",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcDistributionFlowElementType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionElementType"
	      ],
	      "fields": {}
	    },
	    "IfcDistributionPort": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcPort"
	      ],
	      "fields": {
	        "FlowDirection": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDocumentElectronicFormat": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {
	        "FileExtension": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MimeContentType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MimeSubtype": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDocumentInformation": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [
	        "IfcDocumentSelect"
	      ],
	      "fields": {
	        "DocumentId": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DocumentReferences": {
	          "type": "IfcDocumentReference",
	          "reference": true,
	          "many": true
	        },
	        "Purpose": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "IntendedUse": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Scope": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Revision": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DocumentOwner": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "Editors": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": true
	        },
	        "CreationTime": {
	          "type": "IfcDateAndTime",
	          "reference": true,
	          "many": false
	        },
	        "LastRevisionTime": {
	          "type": "IfcDateAndTime",
	          "reference": true,
	          "many": false
	        },
	        "ElectronicFormat": {
	          "type": "IfcDocumentElectronicFormat",
	          "reference": true,
	          "many": false
	        },
	        "ValidFrom": {
	          "type": "IfcCalendarDate",
	          "reference": true,
	          "many": false
	        },
	        "ValidUntil": {
	          "type": "IfcCalendarDate",
	          "reference": true,
	          "many": false
	        },
	        "Confidentiality": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Status": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "IsPointedTo": {
	          "type": "IfcDocumentInformationRelationship",
	          "reference": true,
	          "many": true
	        },
	        "IsPointer": {
	          "type": "IfcDocumentInformationRelationship",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcDocumentInformationRelationship": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {
	        "RelatingDocument": {
	          "type": "IfcDocumentInformation",
	          "reference": true,
	          "many": false
	        },
	        "RelatedDocuments": {
	          "type": "IfcDocumentInformation",
	          "reference": true,
	          "many": true
	        },
	        "RelationshipType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDocumentReference": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [
	        "IfcExternalReference",
	        "IfcDocumentSelect"
	      ],
	      "fields": {
	        "ReferenceToDocument": {
	          "type": "IfcDocumentInformation",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcDoor": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "OverallHeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OverallHeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "OverallWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OverallWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDoorLiningProperties": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "LiningDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LiningDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LiningThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LiningThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThresholdDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThresholdDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThresholdThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThresholdThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TransomThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TransomThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TransomOffset": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TransomOffsetAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LiningOffset": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LiningOffsetAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThresholdOffset": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThresholdOffsetAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CasingThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CasingThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CasingDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CasingDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShapeAspectStyle": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcDoorPanelProperties": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "PanelDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PanelDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PanelOperation": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "PanelWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PanelWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PanelPosition": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ShapeAspectStyle": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcDoorStyle": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcTypeProduct"
	      ],
	      "fields": {
	        "OperationType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ConstructionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ParameterTakesPrecedence": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Sizeable": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDraughtingCallout": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Contents": {
	          "type": "IfcDraughtingCalloutElement",
	          "reference": true,
	          "many": true
	        },
	        "IsRelatedFromCallout": {
	          "type": "IfcDraughtingCalloutRelationship",
	          "reference": true,
	          "many": true
	        },
	        "IsRelatedToCallout": {
	          "type": "IfcDraughtingCalloutRelationship",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcDraughtingCalloutRelationship": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RelatingDraughtingCallout": {
	          "type": "IfcDraughtingCallout",
	          "reference": true,
	          "many": false
	        },
	        "RelatedDraughtingCallout": {
	          "type": "IfcDraughtingCallout",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcDraughtingPreDefinedColour": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcPreDefinedColour"
	      ],
	      "fields": {}
	    },
	    "IfcDraughtingPreDefinedCurveFont": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcPreDefinedCurveFont"
	      ],
	      "fields": {}
	    },
	    "IfcDraughtingPreDefinedTextFont": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcPreDefinedTextFont"
	      ],
	      "fields": {}
	    },
	    "IfcDuctFittingType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowFittingType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDuctSegmentType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowSegmentType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDuctSilencerType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowTreatmentDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEdge": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcTopologicalRepresentationItem"
	      ],
	      "fields": {
	        "EdgeStart": {
	          "type": "IfcVertex",
	          "reference": true,
	          "many": false
	        },
	        "EdgeEnd": {
	          "type": "IfcVertex",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcEdgeCurve": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcEdge",
	        "IfcCurveOrEdgeCurve"
	      ],
	      "fields": {
	        "EdgeGeometry": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "SameSense": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEdgeFeature": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcFeatureElementSubtraction"
	      ],
	      "fields": {
	        "FeatureLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FeatureLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEdgeLoop": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcLoop"
	      ],
	      "fields": {
	        "EdgeList": {
	          "type": "IfcOrientedEdge",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcElectricApplianceType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricDistributionPoint": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowController"
	      ],
	      "fields": {
	        "DistributionPointFunction": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedFunction": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricFlowStorageDeviceType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowStorageDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricGeneratorType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricHeaterType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricMotorType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricTimeControlType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowControllerType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricalBaseProperties": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcEnergyProperties"
	      ],
	      "fields": {
	        "ElectricCurrentType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "InputVoltage": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "InputVoltageAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "InputFrequency": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "InputFrequencyAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FullLoadCurrent": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FullLoadCurrentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MinimumCircuitCurrent": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MinimumCircuitCurrentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MaximumPowerInput": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MaximumPowerInputAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RatedPowerInput": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RatedPowerInputAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "InputPhase": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricalCircuit": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcSystem"
	      ],
	      "fields": {}
	    },
	    "IfcElectricalElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {}
	    },
	    "IfcElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcProduct",
	        "IfcStructuralActivityAssignmentSelect"
	      ],
	      "fields": {
	        "Tag": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HasStructuralMember": {
	          "type": "IfcRelConnectsStructuralElement",
	          "reference": true,
	          "many": true
	        },
	        "FillsVoids": {
	          "type": "IfcRelFillsElement",
	          "reference": true,
	          "many": true
	        },
	        "ConnectedTo": {
	          "type": "IfcRelConnectsElements",
	          "reference": true,
	          "many": true
	        },
	        "HasCoverings": {
	          "type": "IfcRelCoversBldgElements",
	          "reference": true,
	          "many": true
	        },
	        "HasProjections": {
	          "type": "IfcRelProjectsElement",
	          "reference": true,
	          "many": true
	        },
	        "ReferencedInStructures": {
	          "type": "IfcRelReferencedInSpatialStructure",
	          "reference": true,
	          "many": true
	        },
	        "HasPorts": {
	          "type": "IfcRelConnectsPortToElement",
	          "reference": true,
	          "many": true
	        },
	        "HasOpenings": {
	          "type": "IfcRelVoidsElement",
	          "reference": true,
	          "many": true
	        },
	        "IsConnectionRealization": {
	          "type": "IfcRelConnectsWithRealizingElements",
	          "reference": true,
	          "many": true
	        },
	        "ProvidesBoundaries": {
	          "type": "IfcRelSpaceBoundary",
	          "reference": true,
	          "many": true
	        },
	        "ConnectedFrom": {
	          "type": "IfcRelConnectsElements",
	          "reference": true,
	          "many": true
	        },
	        "ContainedInStructure": {
	          "type": "IfcRelContainedInSpatialStructure",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcElementAssembly": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {
	        "AssemblyPlace": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElementComponent": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {}
	    },
	    "IfcElementComponentType": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcElementType"
	      ],
	      "fields": {}
	    },
	    "IfcElementQuantity": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "MethodOfMeasurement": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Quantities": {
	          "type": "IfcPhysicalQuantity",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcElementType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcTypeProduct"
	      ],
	      "fields": {
	        "ElementType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElementarySurface": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcSurface"
	      ],
	      "fields": {
	        "Position": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEllipse": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcConic"
	      ],
	      "fields": {
	        "SemiAxis1": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SemiAxis1AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SemiAxis2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SemiAxis2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEllipseProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "SemiAxis1": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SemiAxis1AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SemiAxis2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SemiAxis2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEnergyConversionDevice": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcEnergyConversionDeviceType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {}
	    },
	    "IfcEnergyProperties": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "EnergySequence": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedEnergySequence": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEnvironmentalImpactValue": {
	      "domain": "ifccostresource",
	      "superclasses": [
	        "IfcAppliedValue"
	      ],
	      "fields": {
	        "ImpactType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Category": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedCategory": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEquipmentElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {}
	    },
	    "IfcEquipmentStandard": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {}
	    },
	    "IfcEvaporativeCoolerType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEvaporatorType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcExtendedMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "ExtendedProperties": {
	          "type": "IfcProperty",
	          "reference": true,
	          "many": true
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcExternalReference": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [
	        "IfcLightDistributionDataSourceSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Location": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ItemReference": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcExternallyDefinedHatchStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcExternalReference",
	        "IfcFillStyleSelect"
	      ],
	      "fields": {}
	    },
	    "IfcExternallyDefinedSurfaceStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcExternalReference",
	        "IfcSurfaceStyleElementSelect"
	      ],
	      "fields": {}
	    },
	    "IfcExternallyDefinedSymbol": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcExternalReference",
	        "IfcDefinedSymbolSelect"
	      ],
	      "fields": {}
	    },
	    "IfcExternallyDefinedTextFont": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcExternalReference",
	        "IfcTextFontSelect"
	      ],
	      "fields": {}
	    },
	    "IfcExtrudedAreaSolid": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcSweptAreaSolid"
	      ],
	      "fields": {
	        "ExtrudedDirection": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        },
	        "Depth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFace": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcTopologicalRepresentationItem"
	      ],
	      "fields": {
	        "Bounds": {
	          "type": "IfcFaceBound",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcFaceBasedSurfaceModel": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcSurfaceOrFaceSurface"
	      ],
	      "fields": {
	        "FbsmFaces": {
	          "type": "IfcConnectedFaceSet",
	          "reference": true,
	          "many": true
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFaceBound": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcTopologicalRepresentationItem"
	      ],
	      "fields": {
	        "Bound": {
	          "type": "IfcLoop",
	          "reference": true,
	          "many": false
	        },
	        "Orientation": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFaceOuterBound": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcFaceBound"
	      ],
	      "fields": {}
	    },
	    "IfcFaceSurface": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcFace",
	        "IfcSurfaceOrFaceSurface"
	      ],
	      "fields": {
	        "FaceSurface": {
	          "type": "IfcSurface",
	          "reference": true,
	          "many": false
	        },
	        "SameSense": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFacetedBrep": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcManifoldSolidBrep"
	      ],
	      "fields": {}
	    },
	    "IfcFacetedBrepWithVoids": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcManifoldSolidBrep"
	      ],
	      "fields": {
	        "Voids": {
	          "type": "IfcClosedShell",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcFailureConnectionCondition": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralConnectionCondition"
	      ],
	      "fields": {
	        "TensionFailureX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TensionFailureXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TensionFailureY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TensionFailureYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TensionFailureZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TensionFailureZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CompressionFailureX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CompressionFailureXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CompressionFailureY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CompressionFailureYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CompressionFailureZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CompressionFailureZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFanType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowMovingDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFastener": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcElementComponent"
	      ],
	      "fields": {}
	    },
	    "IfcFastenerType": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcElementComponentType"
	      ],
	      "fields": {}
	    },
	    "IfcFeatureElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {}
	    },
	    "IfcFeatureElementAddition": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcFeatureElement"
	      ],
	      "fields": {
	        "ProjectsElements": {
	          "type": "IfcRelProjectsElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcFeatureElementSubtraction": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcFeatureElement"
	      ],
	      "fields": {
	        "VoidsElements": {
	          "type": "IfcRelVoidsElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcFillAreaStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcPresentationStyle",
	        "IfcPresentationStyleSelect"
	      ],
	      "fields": {
	        "FillStyles": {
	          "type": "IfcFillStyleSelect",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcFillAreaStyleHatching": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcFillStyleSelect"
	      ],
	      "fields": {
	        "HatchLineAppearance": {
	          "type": "IfcCurveStyle",
	          "reference": true,
	          "many": false
	        },
	        "StartOfNextHatchLine": {
	          "type": "IfcHatchLineDistanceSelect",
	          "reference": true,
	          "many": false
	        },
	        "PointOfReferenceHatchLine": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": false
	        },
	        "PatternStart": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": false
	        },
	        "HatchLineAngle": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HatchLineAngleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFillAreaStyleTileSymbolWithStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcFillAreaStyleTileShapeSelect"
	      ],
	      "fields": {
	        "Symbol": {
	          "type": "IfcAnnotationSymbolOccurrence",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcFillAreaStyleTiles": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcFillStyleSelect"
	      ],
	      "fields": {
	        "TilingPattern": {
	          "type": "IfcOneDirectionRepeatFactor",
	          "reference": true,
	          "many": false
	        },
	        "Tiles": {
	          "type": "IfcFillAreaStyleTileShapeSelect",
	          "reference": true,
	          "many": true
	        },
	        "TilingScale": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TilingScaleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFilterType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowTreatmentDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFireSuppressionTerminalType": {
	      "domain": "ifcplumbingfireprotectiondomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFlowController": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcFlowControllerType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {}
	    },
	    "IfcFlowFitting": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcFlowFittingType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {}
	    },
	    "IfcFlowInstrumentType": {
	      "domain": "ifcbuildingcontrolsdomain",
	      "superclasses": [
	        "IfcDistributionControlElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFlowMeterType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowControllerType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFlowMovingDevice": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcFlowMovingDeviceType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {}
	    },
	    "IfcFlowSegment": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcFlowSegmentType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {}
	    },
	    "IfcFlowStorageDevice": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcFlowStorageDeviceType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {}
	    },
	    "IfcFlowTerminal": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcFlowTerminalType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {}
	    },
	    "IfcFlowTreatmentDevice": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElement"
	      ],
	      "fields": {}
	    },
	    "IfcFlowTreatmentDeviceType": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcDistributionFlowElementType"
	      ],
	      "fields": {}
	    },
	    "IfcFluidFlowProperties": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "PropertySource": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "FlowConditionTimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "VelocityTimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "FlowrateTimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "Fluid": {
	          "type": "IfcMaterial",
	          "reference": true,
	          "many": false
	        },
	        "PressureTimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "UserDefinedPropertySource": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TemperatureSingleValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TemperatureSingleValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WetBulbTemperatureSingleValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WetBulbTemperatureSingleValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WetBulbTemperatureTimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "TemperatureTimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "FlowrateSingleValue": {
	          "type": "IfcDerivedMeasureValue",
	          "reference": true,
	          "many": false
	        },
	        "FlowConditionSingleValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlowConditionSingleValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "VelocitySingleValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "VelocitySingleValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PressureSingleValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PressureSingleValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFooting": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFuelProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "CombustionTemperature": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CombustionTemperatureAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CarbonContent": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CarbonContentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LowerHeatingValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LowerHeatingValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HigherHeatingValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HigherHeatingValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFurnishingElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {}
	    },
	    "IfcFurnishingElementType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElementType"
	      ],
	      "fields": {}
	    },
	    "IfcFurnitureStandard": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {}
	    },
	    "IfcFurnitureType": {
	      "domain": "ifcsharedfacilitieselements",
	      "superclasses": [
	        "IfcFurnishingElementType"
	      ],
	      "fields": {
	        "AssemblyPlace": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcGasTerminalType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcGeneralMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "MolecularWeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MolecularWeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Porosity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PorosityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MassDensity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MassDensityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcGeneralProfileProperties": {
	      "domain": "ifcprofilepropertyresource",
	      "superclasses": [
	        "IfcProfileProperties"
	      ],
	      "fields": {
	        "PhysicalWeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PhysicalWeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Perimeter": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PerimeterAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MinimumPlateThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MinimumPlateThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MaximumPlateThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MaximumPlateThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CrossSectionArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CrossSectionAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcGeometricCurveSet": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricSet"
	      ],
	      "fields": {}
	    },
	    "IfcGeometricRepresentationContext": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcRepresentationContext"
	      ],
	      "fields": {
	        "CoordinateSpaceDimension": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "Precision": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PrecisionAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WorldCoordinateSystem": {
	          "type": "IfcAxis2Placement",
	          "reference": true,
	          "many": false
	        },
	        "TrueNorth": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        },
	        "HasSubContexts": {
	          "type": "IfcGeometricRepresentationSubContext",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcGeometricRepresentationItem": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcRepresentationItem"
	      ],
	      "fields": {}
	    },
	    "IfcGeometricRepresentationSubContext": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcGeometricRepresentationContext"
	      ],
	      "fields": {
	        "ParentContext": {
	          "type": "IfcGeometricRepresentationContext",
	          "reference": true,
	          "many": false
	        },
	        "TargetScale": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TargetScaleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TargetView": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedTargetView": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcGeometricSet": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Elements": {
	          "type": "IfcGeometricSetSelect",
	          "reference": true,
	          "many": true
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcGrid": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcProduct"
	      ],
	      "fields": {
	        "UAxes": {
	          "type": "IfcGridAxis",
	          "reference": true,
	          "many": true
	        },
	        "VAxes": {
	          "type": "IfcGridAxis",
	          "reference": true,
	          "many": true
	        },
	        "WAxes": {
	          "type": "IfcGridAxis",
	          "reference": true,
	          "many": true
	        },
	        "ContainedInStructure": {
	          "type": "IfcRelContainedInSpatialStructure",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcGridAxis": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [],
	      "fields": {
	        "AxisTag": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AxisCurve": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "SameSense": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "PartOfW": {
	          "type": "IfcGrid",
	          "reference": true,
	          "many": true
	        },
	        "PartOfV": {
	          "type": "IfcGrid",
	          "reference": true,
	          "many": true
	        },
	        "PartOfU": {
	          "type": "IfcGrid",
	          "reference": true,
	          "many": true
	        },
	        "HasIntersections": {
	          "type": "IfcVirtualGridIntersection",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcGridPlacement": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [
	        "IfcObjectPlacement"
	      ],
	      "fields": {
	        "PlacementLocation": {
	          "type": "IfcVirtualGridIntersection",
	          "reference": true,
	          "many": false
	        },
	        "PlacementRefDirection": {
	          "type": "IfcVirtualGridIntersection",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcGroup": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObject"
	      ],
	      "fields": {
	        "IsGroupedBy": {
	          "type": "IfcRelAssignsToGroup",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcHalfSpaceSolid": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcBooleanOperand"
	      ],
	      "fields": {
	        "BaseSurface": {
	          "type": "IfcSurface",
	          "reference": true,
	          "many": false
	        },
	        "AgreementFlag": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcHeatExchangerType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcHumidifierType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcHygroscopicMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "UpperVaporResistanceFactor": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "UpperVaporResistanceFactorAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LowerVaporResistanceFactor": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LowerVaporResistanceFactorAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "IsothermalMoistureCapacity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "IsothermalMoistureCapacityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "VaporPermeability": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "VaporPermeabilityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MoistureDiffusivity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MoistureDiffusivityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcIShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "OverallWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OverallWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "OverallDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OverallDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WebThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WebThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcImageTexture": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSurfaceTexture"
	      ],
	      "fields": {
	        "UrlReference": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcInventory": {
	      "domain": "ifcsharedfacilitieselements",
	      "superclasses": [
	        "IfcGroup"
	      ],
	      "fields": {
	        "InventoryType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Jurisdiction": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "ResponsiblePersons": {
	          "type": "IfcPerson",
	          "reference": true,
	          "many": true
	        },
	        "LastUpdateDate": {
	          "type": "IfcCalendarDate",
	          "reference": true,
	          "many": false
	        },
	        "CurrentValue": {
	          "type": "IfcCostValue",
	          "reference": true,
	          "many": false
	        },
	        "OriginalValue": {
	          "type": "IfcCostValue",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcIrregularTimeSeries": {
	      "domain": "ifctimeseriesresource",
	      "superclasses": [
	        "IfcTimeSeries"
	      ],
	      "fields": {
	        "Values": {
	          "type": "IfcIrregularTimeSeriesValue",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcIrregularTimeSeriesValue": {
	      "domain": "ifctimeseriesresource",
	      "superclasses": [],
	      "fields": {
	        "TimeStamp": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "ListValues": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcJunctionBoxType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowFittingType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "Depth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Width": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Thickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EdgeRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EdgeRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LegSlope": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LegSlopeAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLaborResource": {
	      "domain": "ifcconstructionmgmtdomain",
	      "superclasses": [
	        "IfcConstructionResource"
	      ],
	      "fields": {
	        "SkillSet": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLampType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLibraryInformation": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [
	        "IfcLibrarySelect"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Version": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Publisher": {
	          "type": "IfcOrganization",
	          "reference": true,
	          "many": false
	        },
	        "VersionDate": {
	          "type": "IfcCalendarDate",
	          "reference": true,
	          "many": false
	        },
	        "LibraryReference": {
	          "type": "IfcLibraryReference",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcLibraryReference": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [
	        "IfcExternalReference",
	        "IfcLibrarySelect"
	      ],
	      "fields": {
	        "ReferenceIntoLibrary": {
	          "type": "IfcLibraryInformation",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcLightDistributionData": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [],
	      "fields": {
	        "MainPlaneAngle": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MainPlaneAngleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SecondaryPlaneAngle": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "SecondaryPlaneAngleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "LuminousIntensity": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "LuminousIntensityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        }
	      }
	    },
	    "IfcLightFixtureType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLightIntensityDistribution": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [
	        "IfcLightDistributionDataSourceSelect"
	      ],
	      "fields": {
	        "LightDistributionCurve": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "DistributionData": {
	          "type": "IfcLightDistributionData",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcLightSource": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LightColour": {
	          "type": "IfcColourRgb",
	          "reference": true,
	          "many": false
	        },
	        "AmbientIntensity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "AmbientIntensityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Intensity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "IntensityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLightSourceAmbient": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [
	        "IfcLightSource"
	      ],
	      "fields": {}
	    },
	    "IfcLightSourceDirectional": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [
	        "IfcLightSource"
	      ],
	      "fields": {
	        "Orientation": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcLightSourceGoniometric": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [
	        "IfcLightSource"
	      ],
	      "fields": {
	        "Position": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": false
	        },
	        "ColourAppearance": {
	          "type": "IfcColourRgb",
	          "reference": true,
	          "many": false
	        },
	        "ColourTemperature": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ColourTemperatureAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LuminousFlux": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LuminousFluxAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LightEmissionSource": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "LightDistributionDataSource": {
	          "type": "IfcLightDistributionDataSourceSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcLightSourcePositional": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [
	        "IfcLightSource"
	      ],
	      "fields": {
	        "Position": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": false
	        },
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ConstantAttenuation": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ConstantAttenuationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DistanceAttenuation": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DistanceAttenuationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "QuadricAttenuation": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "QuadricAttenuationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLightSourceSpot": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [
	        "IfcLightSourcePositional"
	      ],
	      "fields": {
	        "Orientation": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        },
	        "ConcentrationExponent": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ConcentrationExponentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SpreadAngle": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SpreadAngleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BeamWidthAngle": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BeamWidthAngleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLine": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCurve"
	      ],
	      "fields": {
	        "Pnt": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": false
	        },
	        "Dir": {
	          "type": "IfcVector",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcLinearDimension": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcDimensionCurveDirectedCallout"
	      ],
	      "fields": {}
	    },
	    "IfcLocalPlacement": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [
	        "IfcObjectPlacement"
	      ],
	      "fields": {
	        "PlacementRelTo": {
	          "type": "IfcObjectPlacement",
	          "reference": true,
	          "many": false
	        },
	        "RelativePlacement": {
	          "type": "IfcAxis2Placement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcLocalTime": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [
	        "IfcDateTimeSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "HourComponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "MinuteComponent": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "SecondComponent": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SecondComponentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Zone": {
	          "type": "IfcCoordinatedUniversalTimeOffset",
	          "reference": true,
	          "many": false
	        },
	        "DaylightSavingOffset": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLoop": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcTopologicalRepresentationItem"
	      ],
	      "fields": {}
	    },
	    "IfcManifoldSolidBrep": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcSolidModel"
	      ],
	      "fields": {
	        "Outer": {
	          "type": "IfcClosedShell",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcMappedItem": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcRepresentationItem"
	      ],
	      "fields": {
	        "MappingSource": {
	          "type": "IfcRepresentationMap",
	          "reference": true,
	          "many": false
	        },
	        "MappingTarget": {
	          "type": "IfcCartesianTransformationOperator",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcMaterial": {
	      "domain": "ifcmaterialresource",
	      "superclasses": [
	        "IfcMaterialSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HasRepresentation": {
	          "type": "IfcMaterialDefinitionRepresentation",
	          "reference": true,
	          "many": true
	        },
	        "ClassifiedAs": {
	          "type": "IfcMaterialClassificationRelationship",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcMaterialClassificationRelationship": {
	      "domain": "ifcmaterialresource",
	      "superclasses": [],
	      "fields": {
	        "MaterialClassifications": {
	          "type": "IfcClassificationNotationSelect",
	          "reference": true,
	          "many": true
	        },
	        "ClassifiedMaterial": {
	          "type": "IfcMaterial",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcMaterialDefinitionRepresentation": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcProductRepresentation"
	      ],
	      "fields": {
	        "RepresentedMaterial": {
	          "type": "IfcMaterial",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcMaterialLayer": {
	      "domain": "ifcmaterialresource",
	      "superclasses": [
	        "IfcMaterialSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Material": {
	          "type": "IfcMaterial",
	          "reference": true,
	          "many": false
	        },
	        "LayerThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LayerThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "IsVentilated": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ToMaterialLayerSet": {
	          "type": "IfcMaterialLayerSet",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcMaterialLayerSet": {
	      "domain": "ifcmaterialresource",
	      "superclasses": [
	        "IfcMaterialSelect"
	      ],
	      "fields": {
	        "MaterialLayers": {
	          "type": "IfcMaterialLayer",
	          "reference": true,
	          "many": true
	        },
	        "LayerSetName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TotalThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TotalThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMaterialLayerSetUsage": {
	      "domain": "ifcmaterialresource",
	      "superclasses": [
	        "IfcMaterialSelect"
	      ],
	      "fields": {
	        "ForLayerSet": {
	          "type": "IfcMaterialLayerSet",
	          "reference": true,
	          "many": false
	        },
	        "LayerSetDirection": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "DirectionSense": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "OffsetFromReferenceLine": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OffsetFromReferenceLineAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMaterialList": {
	      "domain": "ifcmaterialresource",
	      "superclasses": [
	        "IfcMaterialSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Materials": {
	          "type": "IfcMaterial",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [],
	      "fields": {
	        "Material": {
	          "type": "IfcMaterial",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcMeasureWithUnit": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcAppliedValueSelect",
	        "IfcConditionCriterionSelect",
	        "IfcMetricValueSelect"
	      ],
	      "fields": {
	        "ValueComponent": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": false
	        },
	        "UnitComponent": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcMechanicalConcreteMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMechanicalMaterialProperties"
	      ],
	      "fields": {
	        "CompressiveStrength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CompressiveStrengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MaxAggregateSize": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MaxAggregateSizeAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AdmixturesDescription": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Workability": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ProtectivePoreRatio": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ProtectivePoreRatioAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WaterImpermeability": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMechanicalFastener": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcFastener"
	      ],
	      "fields": {
	        "NominalDiameter": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "NominalDiameterAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "NominalLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "NominalLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMechanicalFastenerType": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcFastenerType"
	      ],
	      "fields": {}
	    },
	    "IfcMechanicalMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "DynamicViscosity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DynamicViscosityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "YoungModulus": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "YoungModulusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShearModulus": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ShearModulusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PoissonRatio": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PoissonRatioAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThermalExpansionCoefficient": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThermalExpansionCoefficientAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMechanicalSteelMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMechanicalMaterialProperties"
	      ],
	      "fields": {
	        "YieldStress": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "YieldStressAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "UltimateStress": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "UltimateStressAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "UltimateStrain": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "UltimateStrainAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HardeningModule": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HardeningModuleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ProportionalStress": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ProportionalStressAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PlasticStrain": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PlasticStrainAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Relaxations": {
	          "type": "IfcRelaxation",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcMember": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {}
	    },
	    "IfcMemberType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMetric": {
	      "domain": "ifcconstraintresource",
	      "superclasses": [
	        "IfcConstraint"
	      ],
	      "fields": {
	        "Benchmark": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ValueSource": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DataValue": {
	          "type": "IfcMetricValueSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcMonetaryUnit": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcUnit"
	      ],
	      "fields": {
	        "Currency": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMotorConnectionType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMove": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [
	        "IfcTask"
	      ],
	      "fields": {
	        "MoveFrom": {
	          "type": "IfcSpatialStructureElement",
	          "reference": true,
	          "many": false
	        },
	        "MoveTo": {
	          "type": "IfcSpatialStructureElement",
	          "reference": true,
	          "many": false
	        },
	        "PunchList": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        }
	      }
	    },
	    "IfcNamedUnit": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcUnit"
	      ],
	      "fields": {
	        "Dimensions": {
	          "type": "IfcDimensionalExponents",
	          "reference": true,
	          "many": false
	        },
	        "UnitType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcObject": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObjectDefinition"
	      ],
	      "fields": {
	        "ObjectType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "IsDefinedBy": {
	          "type": "IfcRelDefines",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcObjectDefinition": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRoot"
	      ],
	      "fields": {
	        "HasAssignments": {
	          "type": "IfcRelAssigns",
	          "reference": true,
	          "many": true
	        },
	        "IsDecomposedBy": {
	          "type": "IfcRelDecomposes",
	          "reference": true,
	          "many": true
	        },
	        "Decomposes": {
	          "type": "IfcRelDecomposes",
	          "reference": true,
	          "many": true
	        },
	        "HasAssociations": {
	          "type": "IfcRelAssociates",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcObjectPlacement": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [],
	      "fields": {
	        "PlacesObject": {
	          "type": "IfcProduct",
	          "reference": true,
	          "many": true
	        },
	        "ReferencedByPlacements": {
	          "type": "IfcLocalPlacement",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcObjective": {
	      "domain": "ifcconstraintresource",
	      "superclasses": [
	        "IfcConstraint"
	      ],
	      "fields": {
	        "BenchmarkValues": {
	          "type": "IfcMetric",
	          "reference": true,
	          "many": false
	        },
	        "ResultValues": {
	          "type": "IfcMetric",
	          "reference": true,
	          "many": false
	        },
	        "ObjectiveQualifier": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedQualifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcOccupant": {
	      "domain": "ifcsharedfacilitieselements",
	      "superclasses": [
	        "IfcActor"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcOffsetCurve2D": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCurve"
	      ],
	      "fields": {
	        "BasisCurve": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "Distance": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DistanceAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SelfIntersect": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcOffsetCurve3D": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcCurve"
	      ],
	      "fields": {
	        "BasisCurve": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "Distance": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DistanceAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SelfIntersect": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        },
	        "RefDirection": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcOneDirectionRepeatFactor": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcHatchLineDistanceSelect"
	      ],
	      "fields": {
	        "RepeatFactor": {
	          "type": "IfcVector",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcOpenShell": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcConnectedFaceSet",
	        "IfcShell"
	      ],
	      "fields": {}
	    },
	    "IfcOpeningElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcFeatureElementSubtraction"
	      ],
	      "fields": {
	        "HasFillings": {
	          "type": "IfcRelFillsElement",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcOpticalMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "VisibleTransmittance": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "VisibleTransmittanceAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SolarTransmittance": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SolarTransmittanceAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThermalIrTransmittance": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThermalIrTransmittanceAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThermalIrEmissivityBack": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThermalIrEmissivityBackAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThermalIrEmissivityFront": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThermalIrEmissivityFrontAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "VisibleReflectanceBack": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "VisibleReflectanceBackAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "VisibleReflectanceFront": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "VisibleReflectanceFrontAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SolarReflectanceFront": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SolarReflectanceFrontAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SolarReflectanceBack": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SolarReflectanceBackAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcOrderAction": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [
	        "IfcTask"
	      ],
	      "fields": {
	        "ActionID": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcOrganization": {
	      "domain": "ifcactorresource",
	      "superclasses": [
	        "IfcActorSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Id": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Roles": {
	          "type": "IfcActorRole",
	          "reference": true,
	          "many": true
	        },
	        "Addresses": {
	          "type": "IfcAddress",
	          "reference": true,
	          "many": true
	        },
	        "IsRelatedBy": {
	          "type": "IfcOrganizationRelationship",
	          "reference": true,
	          "many": true
	        },
	        "Relates": {
	          "type": "IfcOrganizationRelationship",
	          "reference": true,
	          "many": true
	        },
	        "Engages": {
	          "type": "IfcPersonAndOrganization",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcOrganizationRelationship": {
	      "domain": "ifcactorresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RelatingOrganization": {
	          "type": "IfcOrganization",
	          "reference": true,
	          "many": false
	        },
	        "RelatedOrganizations": {
	          "type": "IfcOrganization",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcOrientedEdge": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcEdge"
	      ],
	      "fields": {
	        "EdgeElement": {
	          "type": "IfcEdge",
	          "reference": true,
	          "many": false
	        },
	        "Orientation": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcOutletType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcOwnerHistory": {
	      "domain": "ifcutilityresource",
	      "superclasses": [],
	      "fields": {
	        "OwningUser": {
	          "type": "IfcPersonAndOrganization",
	          "reference": true,
	          "many": false
	        },
	        "OwningApplication": {
	          "type": "IfcApplication",
	          "reference": true,
	          "many": false
	        },
	        "State": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ChangeAction": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "LastModifiedDate": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "LastModifyingUser": {
	          "type": "IfcPersonAndOrganization",
	          "reference": true,
	          "many": false
	        },
	        "LastModifyingApplication": {
	          "type": "IfcApplication",
	          "reference": true,
	          "many": false
	        },
	        "CreationDate": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcParameterizedProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcProfileDef"
	      ],
	      "fields": {
	        "Position": {
	          "type": "IfcAxis2Placement2D",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPath": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcTopologicalRepresentationItem"
	      ],
	      "fields": {
	        "EdgeList": {
	          "type": "IfcOrientedEdge",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPerformanceHistory": {
	      "domain": "ifccontrolextension",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "LifeCyclePhase": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPermeableCoveringProperties": {
	      "domain": "ifcarchitecturedomain",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "OperationType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "PanelPosition": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "FrameDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FrameDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FrameThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FrameThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShapeAspectStyle": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPermit": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "PermitID": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPerson": {
	      "domain": "ifcactorresource",
	      "superclasses": [
	        "IfcActorSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Id": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FamilyName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "GivenName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MiddleNames": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "PrefixTitles": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "SuffixTitles": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "Roles": {
	          "type": "IfcActorRole",
	          "reference": true,
	          "many": true
	        },
	        "Addresses": {
	          "type": "IfcAddress",
	          "reference": true,
	          "many": true
	        },
	        "EngagedIn": {
	          "type": "IfcPersonAndOrganization",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPersonAndOrganization": {
	      "domain": "ifcactorresource",
	      "superclasses": [
	        "IfcActorSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "ThePerson": {
	          "type": "IfcPerson",
	          "reference": true,
	          "many": false
	        },
	        "TheOrganization": {
	          "type": "IfcOrganization",
	          "reference": true,
	          "many": false
	        },
	        "Roles": {
	          "type": "IfcActorRole",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPhysicalComplexQuantity": {
	      "domain": "ifcquantityresource",
	      "superclasses": [
	        "IfcPhysicalQuantity"
	      ],
	      "fields": {
	        "HasQuantities": {
	          "type": "IfcPhysicalQuantity",
	          "reference": true,
	          "many": true
	        },
	        "Discrimination": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Quality": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Usage": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPhysicalQuantity": {
	      "domain": "ifcquantityresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PartOfComplex": {
	          "type": "IfcPhysicalComplexQuantity",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPhysicalSimpleQuantity": {
	      "domain": "ifcquantityresource",
	      "superclasses": [
	        "IfcPhysicalQuantity"
	      ],
	      "fields": {
	        "Unit": {
	          "type": "IfcNamedUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPile": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ConstructionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPipeFittingType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowFittingType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPipeSegmentType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowSegmentType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPixelTexture": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSurfaceTexture"
	      ],
	      "fields": {
	        "Width": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "Height": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "ColourComponents": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPlacement": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Location": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPlanarBox": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcPlanarExtent"
	      ],
	      "fields": {
	        "Placement": {
	          "type": "IfcAxis2Placement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPlanarExtent": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "SizeInX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SizeInXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SizeInY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SizeInYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPlane": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcElementarySurface"
	      ],
	      "fields": {}
	    },
	    "IfcPlate": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {}
	    },
	    "IfcPlateType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPoint": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcGeometricSetSelect",
	        "IfcPointOrVertexPoint"
	      ],
	      "fields": {}
	    },
	    "IfcPointOnCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcPoint"
	      ],
	      "fields": {
	        "BasisCurve": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "PointParameter": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PointParameterAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPointOnSurface": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcPoint"
	      ],
	      "fields": {
	        "BasisSurface": {
	          "type": "IfcSurface",
	          "reference": true,
	          "many": false
	        },
	        "PointParameterU": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PointParameterUAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PointParameterV": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PointParameterVAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPolyLoop": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcLoop"
	      ],
	      "fields": {
	        "Polygon": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPolygonalBoundedHalfSpace": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcHalfSpaceSolid"
	      ],
	      "fields": {
	        "Position": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": false
	        },
	        "PolygonalBoundary": {
	          "type": "IfcBoundedCurve",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPolyline": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcBoundedCurve"
	      ],
	      "fields": {
	        "Points": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPort": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcProduct"
	      ],
	      "fields": {
	        "ContainedIn": {
	          "type": "IfcRelConnectsPortToElement",
	          "reference": true,
	          "many": false
	        },
	        "ConnectedFrom": {
	          "type": "IfcRelConnectsPorts",
	          "reference": true,
	          "many": true
	        },
	        "ConnectedTo": {
	          "type": "IfcRelConnectsPorts",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPostalAddress": {
	      "domain": "ifcactorresource",
	      "superclasses": [
	        "IfcAddress"
	      ],
	      "fields": {
	        "InternalLocation": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AddressLines": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "PostalBox": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Town": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Region": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PostalCode": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Country": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPreDefinedColour": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcPreDefinedItem",
	        "IfcColour"
	      ],
	      "fields": {}
	    },
	    "IfcPreDefinedCurveFont": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcPreDefinedItem",
	        "IfcCurveStyleFontSelect"
	      ],
	      "fields": {}
	    },
	    "IfcPreDefinedDimensionSymbol": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcPreDefinedSymbol"
	      ],
	      "fields": {}
	    },
	    "IfcPreDefinedItem": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPreDefinedPointMarkerSymbol": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcPreDefinedSymbol"
	      ],
	      "fields": {}
	    },
	    "IfcPreDefinedSymbol": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcPreDefinedItem",
	        "IfcDefinedSymbolSelect"
	      ],
	      "fields": {}
	    },
	    "IfcPreDefinedTerminatorSymbol": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcPreDefinedSymbol"
	      ],
	      "fields": {}
	    },
	    "IfcPreDefinedTextFont": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcPreDefinedItem",
	        "IfcTextFontSelect"
	      ],
	      "fields": {}
	    },
	    "IfcPresentationLayerAssignment": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AssignedItems": {
	          "type": "IfcLayeredItem",
	          "reference": true,
	          "many": true
	        },
	        "Identifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPresentationLayerWithStyle": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [
	        "IfcPresentationLayerAssignment"
	      ],
	      "fields": {
	        "LayerOn": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        },
	        "LayerFrozen": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        },
	        "LayerBlocked": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        },
	        "LayerStyles": {
	          "type": "IfcPresentationStyleSelect",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPresentationStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPresentationStyleAssignment": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {
	        "Styles": {
	          "type": "IfcPresentationStyleSelect",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcProcedure": {
	      "domain": "ifcprocessextension",
	      "superclasses": [
	        "IfcProcess"
	      ],
	      "fields": {
	        "ProcedureID": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ProcedureType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedProcedureType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcProcess": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObject"
	      ],
	      "fields": {
	        "OperatesOn": {
	          "type": "IfcRelAssignsToProcess",
	          "reference": true,
	          "many": true
	        },
	        "IsSuccessorFrom": {
	          "type": "IfcRelSequence",
	          "reference": true,
	          "many": true
	        },
	        "IsPredecessorTo": {
	          "type": "IfcRelSequence",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcProduct": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObject"
	      ],
	      "fields": {
	        "ObjectPlacement": {
	          "type": "IfcObjectPlacement",
	          "reference": true,
	          "many": false
	        },
	        "Representation": {
	          "type": "IfcProductRepresentation",
	          "reference": true,
	          "many": false
	        },
	        "ReferencedBy": {
	          "type": "IfcRelAssignsToProduct",
	          "reference": true,
	          "many": true
	        },
	        "geometry": {
	          "type": "GeometryInfo",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcProductDefinitionShape": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcProductRepresentation"
	      ],
	      "fields": {
	        "ShapeOfProduct": {
	          "type": "IfcProduct",
	          "reference": true,
	          "many": true
	        },
	        "HasShapeAspects": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcProductRepresentation": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Representations": {
	          "type": "IfcRepresentation",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcProductsOfCombustionProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "SpecificHeatCapacity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SpecificHeatCapacityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "N20Content": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "N20ContentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "COContent": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "COContentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CO2Content": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CO2ContentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [],
	      "fields": {
	        "ProfileType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ProfileName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcProfileProperties": {
	      "domain": "ifcprofilepropertyresource",
	      "superclasses": [],
	      "fields": {
	        "ProfileName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ProfileDefinition": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcProject": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObject"
	      ],
	      "fields": {
	        "LongName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Phase": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RepresentationContexts": {
	          "type": "IfcRepresentationContext",
	          "reference": true,
	          "many": true
	        },
	        "UnitsInContext": {
	          "type": "IfcUnitAssignment",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcProjectOrder": {
	      "domain": "ifcsharedmgmtelements",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "ID": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Status": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcProjectOrderRecord": {
	      "domain": "ifcsharedmgmtelements",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "Records": {
	          "type": "IfcRelAssignsToProjectOrder",
	          "reference": true,
	          "many": true
	        },
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcProjectionCurve": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcAnnotationCurveOccurrence"
	      ],
	      "fields": {}
	    },
	    "IfcProjectionElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcFeatureElementAddition"
	      ],
	      "fields": {}
	    },
	    "IfcProperty": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PropertyForDependance": {
	          "type": "IfcPropertyDependencyRelationship",
	          "reference": true,
	          "many": true
	        },
	        "PropertyDependsOn": {
	          "type": "IfcPropertyDependencyRelationship",
	          "reference": true,
	          "many": true
	        },
	        "PartOfComplex": {
	          "type": "IfcComplexProperty",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPropertyBoundedValue": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [
	        "IfcSimpleProperty"
	      ],
	      "fields": {
	        "UpperBoundValue": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": false
	        },
	        "LowerBoundValue": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": false
	        },
	        "Unit": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPropertyConstraintRelationship": {
	      "domain": "ifcconstraintresource",
	      "superclasses": [],
	      "fields": {
	        "RelatingConstraint": {
	          "type": "IfcConstraint",
	          "reference": true,
	          "many": false
	        },
	        "RelatedProperties": {
	          "type": "IfcProperty",
	          "reference": true,
	          "many": true
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPropertyDefinition": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRoot"
	      ],
	      "fields": {
	        "HasAssociations": {
	          "type": "IfcRelAssociates",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPropertyDependencyRelationship": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [],
	      "fields": {
	        "DependingProperty": {
	          "type": "IfcProperty",
	          "reference": true,
	          "many": false
	        },
	        "DependantProperty": {
	          "type": "IfcProperty",
	          "reference": true,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Expression": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPropertyEnumeratedValue": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [
	        "IfcSimpleProperty"
	      ],
	      "fields": {
	        "EnumerationValues": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": true
	        },
	        "EnumerationReference": {
	          "type": "IfcPropertyEnumeration",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPropertyEnumeration": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EnumerationValues": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": true
	        },
	        "Unit": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPropertyListValue": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [
	        "IfcSimpleProperty"
	      ],
	      "fields": {
	        "ListValues": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": true
	        },
	        "Unit": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPropertyReferenceValue": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [
	        "IfcSimpleProperty"
	      ],
	      "fields": {
	        "UsageName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PropertyReference": {
	          "type": "IfcObjectReferenceSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPropertySet": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "HasProperties": {
	          "type": "IfcProperty",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPropertySetDefinition": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcPropertyDefinition"
	      ],
	      "fields": {
	        "PropertyDefinitionOf": {
	          "type": "IfcRelDefinesByProperties",
	          "reference": true,
	          "many": true
	        },
	        "DefinesType": {
	          "type": "IfcTypeObject",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcPropertySingleValue": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [
	        "IfcSimpleProperty"
	      ],
	      "fields": {
	        "NominalValue": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": false
	        },
	        "Unit": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcPropertyTableValue": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [
	        "IfcSimpleProperty"
	      ],
	      "fields": {
	        "DefiningValues": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": true
	        },
	        "DefinedValues": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": true
	        },
	        "Expression": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DefiningUnit": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": false
	        },
	        "DefinedUnit": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcProtectiveDeviceType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowControllerType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcProxy": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcProduct"
	      ],
	      "fields": {
	        "ProxyType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Tag": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPumpType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowMovingDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcQuantityArea": {
	      "domain": "ifcquantityresource",
	      "superclasses": [
	        "IfcPhysicalSimpleQuantity"
	      ],
	      "fields": {
	        "AreaValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "AreaValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcQuantityCount": {
	      "domain": "ifcquantityresource",
	      "superclasses": [
	        "IfcPhysicalSimpleQuantity"
	      ],
	      "fields": {
	        "CountValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CountValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcQuantityLength": {
	      "domain": "ifcquantityresource",
	      "superclasses": [
	        "IfcPhysicalSimpleQuantity"
	      ],
	      "fields": {
	        "LengthValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LengthValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcQuantityTime": {
	      "domain": "ifcquantityresource",
	      "superclasses": [
	        "IfcPhysicalSimpleQuantity"
	      ],
	      "fields": {
	        "TimeValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TimeValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcQuantityVolume": {
	      "domain": "ifcquantityresource",
	      "superclasses": [
	        "IfcPhysicalSimpleQuantity"
	      ],
	      "fields": {
	        "VolumeValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "VolumeValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcQuantityWeight": {
	      "domain": "ifcquantityresource",
	      "superclasses": [
	        "IfcPhysicalSimpleQuantity"
	      ],
	      "fields": {
	        "WeightValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WeightValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRadiusDimension": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcDimensionCurveDirectedCallout"
	      ],
	      "fields": {}
	    },
	    "IfcRailing": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRailingType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRamp": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "ShapeType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRampFlight": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {}
	    },
	    "IfcRampFlightType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRationalBezierCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcBezierCurve"
	      ],
	      "fields": {
	        "WeightsData": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "WeightsDataAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        }
	      }
	    },
	    "IfcRectangleHollowProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcRectangleProfileDef"
	      ],
	      "fields": {
	        "WallThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WallThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "InnerFilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "InnerFilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "OuterFilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OuterFilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRectangleProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "XDim": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "XDimAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "YDim": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "YDimAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRectangularPyramid": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcCsgPrimitive3D"
	      ],
	      "fields": {
	        "XLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "XLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "YLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "YLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Height": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRectangularTrimmedSurface": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcBoundedSurface"
	      ],
	      "fields": {
	        "BasisSurface": {
	          "type": "IfcSurface",
	          "reference": true,
	          "many": false
	        },
	        "U1": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "U1AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "V1": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "V1AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "U2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "U2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "V2": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "V2AsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Usense": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Vsense": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcReferencesValueDocument": {
	      "domain": "ifccostresource",
	      "superclasses": [],
	      "fields": {
	        "ReferencedDocument": {
	          "type": "IfcDocumentSelect",
	          "reference": true,
	          "many": false
	        },
	        "ReferencingValues": {
	          "type": "IfcAppliedValue",
	          "reference": true,
	          "many": true
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRegularTimeSeries": {
	      "domain": "ifctimeseriesresource",
	      "superclasses": [
	        "IfcTimeSeries"
	      ],
	      "fields": {
	        "TimeStep": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TimeStepAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Values": {
	          "type": "IfcTimeSeriesValue",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcReinforcementBarProperties": {
	      "domain": "ifcprofilepropertyresource",
	      "superclasses": [],
	      "fields": {
	        "TotalCrossSectionArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TotalCrossSectionAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SteelGrade": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BarSurface": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "EffectiveDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EffectiveDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "NominalBarDiameter": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "NominalBarDiameterAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BarCount": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BarCountAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcReinforcementDefinitionProperties": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "DefinitionType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ReinforcementSectionDefinitions": {
	          "type": "IfcSectionReinforcementProperties",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcReinforcingBar": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcReinforcingElement"
	      ],
	      "fields": {
	        "NominalDiameter": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "NominalDiameterAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CrossSectionArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CrossSectionAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BarLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BarLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BarRole": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "BarSurface": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcReinforcingElement": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcBuildingElementComponent"
	      ],
	      "fields": {
	        "SteelGrade": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcReinforcingMesh": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcReinforcingElement"
	      ],
	      "fields": {
	        "MeshLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MeshLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MeshWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MeshWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalBarNominalDiameter": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalBarNominalDiameterAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TransverseBarNominalDiameter": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TransverseBarNominalDiameterAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalBarCrossSectionArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalBarCrossSectionAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TransverseBarCrossSectionArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TransverseBarCrossSectionAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalBarSpacing": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalBarSpacingAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TransverseBarSpacing": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TransverseBarSpacingAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAggregates": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelDecomposes"
	      ],
	      "fields": {}
	    },
	    "IfcRelAssigns": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelationship"
	      ],
	      "fields": {
	        "RelatedObjects": {
	          "type": "IfcObjectDefinition",
	          "reference": true,
	          "many": true
	        },
	        "RelatedObjectsType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssignsTasks": {
	      "domain": "ifcprocessextension",
	      "superclasses": [
	        "IfcRelAssignsToControl"
	      ],
	      "fields": {
	        "TimeForTask": {
	          "type": "IfcScheduleTimeControl",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssignsToActor": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssigns"
	      ],
	      "fields": {
	        "RelatingActor": {
	          "type": "IfcActor",
	          "reference": true,
	          "many": false
	        },
	        "ActingRole": {
	          "type": "IfcActorRole",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssignsToControl": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssigns"
	      ],
	      "fields": {
	        "RelatingControl": {
	          "type": "IfcControl",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssignsToGroup": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssigns"
	      ],
	      "fields": {
	        "RelatingGroup": {
	          "type": "IfcGroup",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssignsToProcess": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssigns"
	      ],
	      "fields": {
	        "RelatingProcess": {
	          "type": "IfcProcess",
	          "reference": true,
	          "many": false
	        },
	        "QuantityInProcess": {
	          "type": "IfcMeasureWithUnit",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssignsToProduct": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssigns"
	      ],
	      "fields": {
	        "RelatingProduct": {
	          "type": "IfcProduct",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssignsToProjectOrder": {
	      "domain": "ifcsharedmgmtelements",
	      "superclasses": [
	        "IfcRelAssignsToControl"
	      ],
	      "fields": {}
	    },
	    "IfcRelAssignsToResource": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssigns"
	      ],
	      "fields": {
	        "RelatingResource": {
	          "type": "IfcResource",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssociates": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelationship"
	      ],
	      "fields": {
	        "RelatedObjects": {
	          "type": "IfcRoot",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRelAssociatesAppliedValue": {
	      "domain": "ifcsharedmgmtelements",
	      "superclasses": [
	        "IfcRelAssociates"
	      ],
	      "fields": {
	        "RelatingAppliedValue": {
	          "type": "IfcAppliedValue",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssociatesApproval": {
	      "domain": "ifccontrolextension",
	      "superclasses": [
	        "IfcRelAssociates"
	      ],
	      "fields": {
	        "RelatingApproval": {
	          "type": "IfcApproval",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssociatesClassification": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssociates"
	      ],
	      "fields": {
	        "RelatingClassification": {
	          "type": "IfcClassificationNotationSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssociatesConstraint": {
	      "domain": "ifccontrolextension",
	      "superclasses": [
	        "IfcRelAssociates"
	      ],
	      "fields": {
	        "Intent": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RelatingConstraint": {
	          "type": "IfcConstraint",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssociatesDocument": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssociates"
	      ],
	      "fields": {
	        "RelatingDocument": {
	          "type": "IfcDocumentSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssociatesLibrary": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelAssociates"
	      ],
	      "fields": {
	        "RelatingLibrary": {
	          "type": "IfcLibrarySelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssociatesMaterial": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelAssociates"
	      ],
	      "fields": {
	        "RelatingMaterial": {
	          "type": "IfcMaterialSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelAssociatesProfileProperties": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcRelAssociates"
	      ],
	      "fields": {
	        "RelatingProfileProperties": {
	          "type": "IfcProfileProperties",
	          "reference": true,
	          "many": false
	        },
	        "ProfileSectionLocation": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        },
	        "ProfileOrientation": {
	          "type": "IfcOrientationSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnects": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelationship"
	      ],
	      "fields": {}
	    },
	    "IfcRelConnectsElements": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "ConnectionGeometry": {
	          "type": "IfcConnectionGeometry",
	          "reference": true,
	          "many": false
	        },
	        "RelatingElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        },
	        "RelatedElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnectsPathElements": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcRelConnectsElements"
	      ],
	      "fields": {
	        "RelatingPriorities": {
	          "type": "int",
	          "reference": false,
	          "many": true
	        },
	        "RelatedPriorities": {
	          "type": "int",
	          "reference": false,
	          "many": true
	        },
	        "RelatedConnectionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "RelatingConnectionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnectsPortToElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingPort": {
	          "type": "IfcPort",
	          "reference": true,
	          "many": false
	        },
	        "RelatedElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnectsPorts": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingPort": {
	          "type": "IfcPort",
	          "reference": true,
	          "many": false
	        },
	        "RelatedPort": {
	          "type": "IfcPort",
	          "reference": true,
	          "many": false
	        },
	        "RealizingElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnectsStructuralActivity": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingElement": {
	          "type": "IfcStructuralActivityAssignmentSelect",
	          "reference": true,
	          "many": false
	        },
	        "RelatedStructuralActivity": {
	          "type": "IfcStructuralActivity",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnectsStructuralElement": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        },
	        "RelatedStructuralMember": {
	          "type": "IfcStructuralMember",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnectsStructuralMember": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingStructuralMember": {
	          "type": "IfcStructuralMember",
	          "reference": true,
	          "many": false
	        },
	        "RelatedStructuralConnection": {
	          "type": "IfcStructuralConnection",
	          "reference": true,
	          "many": false
	        },
	        "AppliedCondition": {
	          "type": "IfcBoundaryCondition",
	          "reference": true,
	          "many": false
	        },
	        "AdditionalConditions": {
	          "type": "IfcStructuralConnectionCondition",
	          "reference": true,
	          "many": false
	        },
	        "SupportedLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SupportedLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ConditionCoordinateSystem": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnectsWithEccentricity": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcRelConnectsStructuralMember"
	      ],
	      "fields": {
	        "ConnectionConstraint": {
	          "type": "IfcConnectionGeometry",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelConnectsWithRealizingElements": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnectsElements"
	      ],
	      "fields": {
	        "RealizingElements": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": true
	        },
	        "ConnectionType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRelContainedInSpatialStructure": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatedElements": {
	          "type": "IfcProduct",
	          "reference": true,
	          "many": true
	        },
	        "RelatingStructure": {
	          "type": "IfcSpatialStructureElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelCoversBldgElements": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingBuildingElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        },
	        "RelatedCoverings": {
	          "type": "IfcCovering",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRelCoversSpaces": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatedSpace": {
	          "type": "IfcSpace",
	          "reference": true,
	          "many": false
	        },
	        "RelatedCoverings": {
	          "type": "IfcCovering",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRelDecomposes": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelationship"
	      ],
	      "fields": {
	        "RelatingObject": {
	          "type": "IfcObjectDefinition",
	          "reference": true,
	          "many": false
	        },
	        "RelatedObjects": {
	          "type": "IfcObjectDefinition",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRelDefines": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelationship"
	      ],
	      "fields": {
	        "RelatedObjects": {
	          "type": "IfcObject",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRelDefinesByProperties": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelDefines"
	      ],
	      "fields": {
	        "RelatingPropertyDefinition": {
	          "type": "IfcPropertySetDefinition",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelDefinesByType": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelDefines"
	      ],
	      "fields": {
	        "RelatingType": {
	          "type": "IfcTypeObject",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelFillsElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingOpeningElement": {
	          "type": "IfcOpeningElement",
	          "reference": true,
	          "many": false
	        },
	        "RelatedBuildingElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelFlowControlElements": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatedControlElements": {
	          "type": "IfcDistributionControlElement",
	          "reference": true,
	          "many": true
	        },
	        "RelatingFlowElement": {
	          "type": "IfcDistributionFlowElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelInteractionRequirements": {
	      "domain": "ifcarchitecturedomain",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "DailyInteraction": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DailyInteractionAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ImportanceRating": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ImportanceRatingAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LocationOfInteraction": {
	          "type": "IfcSpatialStructureElement",
	          "reference": true,
	          "many": false
	        },
	        "RelatedSpaceProgram": {
	          "type": "IfcSpaceProgram",
	          "reference": true,
	          "many": false
	        },
	        "RelatingSpaceProgram": {
	          "type": "IfcSpaceProgram",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelNests": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelDecomposes"
	      ],
	      "fields": {}
	    },
	    "IfcRelOccupiesSpaces": {
	      "domain": "ifcsharedfacilitieselements",
	      "superclasses": [
	        "IfcRelAssignsToActor"
	      ],
	      "fields": {}
	    },
	    "IfcRelOverridesProperties": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelDefinesByProperties"
	      ],
	      "fields": {
	        "OverridingProperties": {
	          "type": "IfcProperty",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRelProjectsElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        },
	        "RelatedFeatureElement": {
	          "type": "IfcFeatureElementAddition",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelReferencedInSpatialStructure": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatedElements": {
	          "type": "IfcProduct",
	          "reference": true,
	          "many": true
	        },
	        "RelatingStructure": {
	          "type": "IfcSpatialStructureElement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelSchedulesCostItems": {
	      "domain": "ifcsharedmgmtelements",
	      "superclasses": [
	        "IfcRelAssignsToControl"
	      ],
	      "fields": {}
	    },
	    "IfcRelSequence": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingProcess": {
	          "type": "IfcProcess",
	          "reference": true,
	          "many": false
	        },
	        "RelatedProcess": {
	          "type": "IfcProcess",
	          "reference": true,
	          "many": false
	        },
	        "TimeLag": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TimeLagAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SequenceType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRelServicesBuildings": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingSystem": {
	          "type": "IfcSystem",
	          "reference": true,
	          "many": false
	        },
	        "RelatedBuildings": {
	          "type": "IfcSpatialStructureElement",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRelSpaceBoundary": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingSpace": {
	          "type": "IfcSpace",
	          "reference": true,
	          "many": false
	        },
	        "RelatedBuildingElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        },
	        "ConnectionGeometry": {
	          "type": "IfcConnectionGeometry",
	          "reference": true,
	          "many": false
	        },
	        "PhysicalOrVirtualBoundary": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "InternalOrExternalBoundary": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRelVoidsElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcRelConnects"
	      ],
	      "fields": {
	        "RelatingBuildingElement": {
	          "type": "IfcElement",
	          "reference": true,
	          "many": false
	        },
	        "RelatedOpeningElement": {
	          "type": "IfcFeatureElementSubtraction",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcRelationship": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcRoot"
	      ],
	      "fields": {}
	    },
	    "IfcRelaxation": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [],
	      "fields": {
	        "RelaxationValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RelaxationValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "InitialStress": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "InitialStressAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRepresentation": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcLayeredItem"
	      ],
	      "fields": {
	        "ContextOfItems": {
	          "type": "IfcRepresentationContext",
	          "reference": true,
	          "many": false
	        },
	        "RepresentationIdentifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RepresentationType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Items": {
	          "type": "IfcRepresentationItem",
	          "reference": true,
	          "many": true
	        },
	        "RepresentationMap": {
	          "type": "IfcRepresentationMap",
	          "reference": true,
	          "many": true
	        },
	        "LayerAssignments": {
	          "type": "IfcPresentationLayerAssignment",
	          "reference": true,
	          "many": true
	        },
	        "OfProductRepresentation": {
	          "type": "IfcProductRepresentation",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRepresentationContext": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [],
	      "fields": {
	        "ContextIdentifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ContextType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RepresentationsInContext": {
	          "type": "IfcRepresentation",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRepresentationItem": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcLayeredItem"
	      ],
	      "fields": {
	        "LayerAssignments": {
	          "type": "IfcPresentationLayerAssignment",
	          "reference": true,
	          "many": true
	        },
	        "StyledByItem": {
	          "type": "IfcStyledItem",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRepresentationMap": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [],
	      "fields": {
	        "MappingOrigin": {
	          "type": "IfcAxis2Placement",
	          "reference": true,
	          "many": false
	        },
	        "MappedRepresentation": {
	          "type": "IfcRepresentation",
	          "reference": true,
	          "many": false
	        },
	        "MapUsage": {
	          "type": "IfcMappedItem",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcResource": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObject"
	      ],
	      "fields": {
	        "ResourceOf": {
	          "type": "IfcRelAssignsToResource",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcRevolvedAreaSolid": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcSweptAreaSolid"
	      ],
	      "fields": {
	        "Axis": {
	          "type": "IfcAxis1Placement",
	          "reference": true,
	          "many": false
	        },
	        "Angle": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "AngleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRibPlateProfileProperties": {
	      "domain": "ifcprofilepropertyresource",
	      "superclasses": [
	        "IfcProfileProperties"
	      ],
	      "fields": {
	        "Thickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RibHeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RibHeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RibWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RibWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RibSpacing": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RibSpacingAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Direction": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRightCircularCone": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcCsgPrimitive3D"
	      ],
	      "fields": {
	        "Height": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BottomRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BottomRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRightCircularCylinder": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcCsgPrimitive3D"
	      ],
	      "fields": {
	        "Height": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRoof": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "ShapeType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRoot": {
	      "domain": "ifckernel",
	      "superclasses": [],
	      "fields": {
	        "GlobalId": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "OwnerHistory": {
	          "type": "IfcOwnerHistory",
	          "reference": true,
	          "many": false
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRoundedEdgeFeature": {
	      "domain": "ifcsharedcomponentelements",
	      "superclasses": [
	        "IfcEdgeFeature"
	      ],
	      "fields": {
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRoundedRectangleProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcRectangleProfileDef"
	      ],
	      "fields": {
	        "RoundingRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RoundingRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSIUnit": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcNamedUnit"
	      ],
	      "fields": {
	        "Prefix": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Name": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSanitaryTerminalType": {
	      "domain": "ifcplumbingfireprotectiondomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcScheduleTimeControl": {
	      "domain": "ifcprocessextension",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "ActualStart": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "EarlyStart": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "LateStart": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "ScheduleStart": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "ActualFinish": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "EarlyFinish": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "LateFinish": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "ScheduleFinish": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "ScheduleDuration": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ScheduleDurationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ActualDuration": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ActualDurationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RemainingTime": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RemainingTimeAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FreeFloat": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FreeFloatAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TotalFloat": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TotalFloatAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "IsCritical": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "StatusTime": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "StartFloat": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "StartFloatAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FinishFloat": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FinishFloatAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Completion": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CompletionAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ScheduleTimeControlAssigned": {
	          "type": "IfcRelAssignsTasks",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSectionProperties": {
	      "domain": "ifcprofilepropertyresource",
	      "superclasses": [],
	      "fields": {
	        "SectionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "StartProfile": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": false
	        },
	        "EndProfile": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSectionReinforcementProperties": {
	      "domain": "ifcprofilepropertyresource",
	      "superclasses": [],
	      "fields": {
	        "LongitudinalStartPosition": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalStartPositionAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalEndPosition": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LongitudinalEndPositionAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TransversePosition": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TransversePositionAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ReinforcementRole": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "SectionDefinition": {
	          "type": "IfcSectionProperties",
	          "reference": true,
	          "many": false
	        },
	        "CrossSectionReinforcementDefinitions": {
	          "type": "IfcReinforcementBarProperties",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcSectionedSpine": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "SpineCurve": {
	          "type": "IfcCompositeCurve",
	          "reference": true,
	          "many": false
	        },
	        "CrossSections": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": true
	        },
	        "CrossSectionPositions": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": true
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSensorType": {
	      "domain": "ifcbuildingcontrolsdomain",
	      "superclasses": [
	        "IfcDistributionControlElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcServiceLife": {
	      "domain": "ifcsharedfacilitieselements",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "ServiceLifeType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ServiceLifeDuration": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ServiceLifeDurationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcServiceLifeFactor": {
	      "domain": "ifcsharedfacilitieselements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UpperValue": {
	          "type": "IfcMeasureValue",
	          "reference": true,
	          "many": false
	        },
	        "MostUsedValue": {
	          "type": "IfcMeasureValue",
	          "reference": true,
	          "many": false
	        },
	        "LowerValue": {
	          "type": "IfcMeasureValue",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcShapeAspect": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [],
	      "fields": {
	        "ShapeRepresentations": {
	          "type": "IfcShapeModel",
	          "reference": true,
	          "many": true
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ProductDefinitional": {
	          "type": "boolean",
	          "reference": false,
	          "many": false
	        },
	        "PartOfProductDefinitionShape": {
	          "type": "IfcProductDefinitionShape",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcShapeModel": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcRepresentation"
	      ],
	      "fields": {
	        "OfShapeAspect": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcShapeRepresentation": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcShapeModel"
	      ],
	      "fields": {}
	    },
	    "IfcShellBasedSurfaceModel": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "SbsmBoundary": {
	          "type": "IfcShell",
	          "reference": true,
	          "many": true
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSimpleProperty": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [
	        "IfcProperty"
	      ],
	      "fields": {}
	    },
	    "IfcSite": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcSpatialStructureElement"
	      ],
	      "fields": {
	        "RefLatitude": {
	          "type": "int",
	          "reference": false,
	          "many": true
	        },
	        "RefLongitude": {
	          "type": "int",
	          "reference": false,
	          "many": true
	        },
	        "RefElevation": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RefElevationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LandTitleNumber": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SiteAddress": {
	          "type": "IfcPostalAddress",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSlab": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSlabType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSlippageConnectionCondition": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralConnectionCondition"
	      ],
	      "fields": {
	        "SlippageX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SlippageXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SlippageY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SlippageYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SlippageZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SlippageZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSolidModel": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcBooleanOperand"
	      ],
	      "fields": {
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSoundProperties": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "IsAttenuating": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "SoundScale": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "SoundValues": {
	          "type": "IfcSoundValue",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcSoundValue": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "SoundLevelTimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "Frequency": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FrequencyAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SoundLevelSingleValue": {
	          "type": "IfcDerivedMeasureValue",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSpace": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcSpatialStructureElement"
	      ],
	      "fields": {
	        "InteriorOrExteriorSpace": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ElevationWithFlooring": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ElevationWithFlooringAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HasCoverings": {
	          "type": "IfcRelCoversSpaces",
	          "reference": true,
	          "many": true
	        },
	        "BoundedBy": {
	          "type": "IfcRelSpaceBoundary",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcSpaceHeaterType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSpaceProgram": {
	      "domain": "ifcarchitecturedomain",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "SpaceProgramIdentifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MaxRequiredArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MaxRequiredAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MinRequiredArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MinRequiredAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RequestedLocation": {
	          "type": "IfcSpatialStructureElement",
	          "reference": true,
	          "many": false
	        },
	        "StandardRequiredArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "StandardRequiredAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HasInteractionReqsFrom": {
	          "type": "IfcRelInteractionRequirements",
	          "reference": true,
	          "many": true
	        },
	        "HasInteractionReqsTo": {
	          "type": "IfcRelInteractionRequirements",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcSpaceThermalLoadProperties": {
	      "domain": "ifcsharedbldgserviceelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "ApplicableValueRatio": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ApplicableValueRatioAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThermalLoadSource": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "PropertySource": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "SourceDescription": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MaximumValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MaximumValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MinimumValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MinimumValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThermalLoadTimeSeriesValues": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "UserDefinedThermalLoadSource": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedPropertySource": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThermalLoadType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSpaceType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcSpatialStructureElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSpatialStructureElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcProduct"
	      ],
	      "fields": {
	        "LongName": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CompositionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ReferencesElements": {
	          "type": "IfcRelReferencedInSpatialStructure",
	          "reference": true,
	          "many": true
	        },
	        "ServicedBySystems": {
	          "type": "IfcRelServicesBuildings",
	          "reference": true,
	          "many": true
	        },
	        "ContainsElements": {
	          "type": "IfcRelContainedInSpatialStructure",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcSpatialStructureElementType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElementType"
	      ],
	      "fields": {}
	    },
	    "IfcSphere": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcCsgPrimitive3D"
	      ],
	      "fields": {
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStackTerminalType": {
	      "domain": "ifcplumbingfireprotectiondomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStair": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "ShapeType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStairFlight": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "NumberOfRiser": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "NumberOfTreads": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        },
	        "RiserHeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RiserHeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TreadLength": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TreadLengthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStairFlightType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralAction": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralActivity"
	      ],
	      "fields": {
	        "DestabilizingLoad": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "CausedBy": {
	          "type": "IfcStructuralReaction",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralActivity": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcProduct"
	      ],
	      "fields": {
	        "AppliedLoad": {
	          "type": "IfcStructuralLoad",
	          "reference": true,
	          "many": false
	        },
	        "GlobalOrLocal": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "AssignedToStructuralItem": {
	          "type": "IfcRelConnectsStructuralActivity",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralAnalysisModel": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcSystem"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "OrientationOf2DPlane": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": false
	        },
	        "LoadedBy": {
	          "type": "IfcStructuralLoadGroup",
	          "reference": true,
	          "many": true
	        },
	        "HasResults": {
	          "type": "IfcStructuralResultGroup",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralConnection": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralItem"
	      ],
	      "fields": {
	        "AppliedCondition": {
	          "type": "IfcBoundaryCondition",
	          "reference": true,
	          "many": false
	        },
	        "ConnectsStructuralMembers": {
	          "type": "IfcRelConnectsStructuralMember",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralConnectionCondition": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralCurveConnection": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralConnection"
	      ],
	      "fields": {}
	    },
	    "IfcStructuralCurveMember": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralMember"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralCurveMemberVarying": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralCurveMember"
	      ],
	      "fields": {}
	    },
	    "IfcStructuralItem": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcProduct",
	        "IfcStructuralActivityAssignmentSelect"
	      ],
	      "fields": {
	        "AssignedStructuralActivity": {
	          "type": "IfcRelConnectsStructuralActivity",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralLinearAction": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralAction"
	      ],
	      "fields": {
	        "ProjectedOrTrue": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralLinearActionVarying": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralLinearAction"
	      ],
	      "fields": {
	        "VaryingAppliedLoadLocation": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        },
	        "SubsequentAppliedLoads": {
	          "type": "IfcStructuralLoad",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralLoad": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralLoadGroup": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcGroup"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ActionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ActionSource": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Coefficient": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CoefficientAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Purpose": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SourceOfResultGroup": {
	          "type": "IfcStructuralResultGroup",
	          "reference": true,
	          "many": true
	        },
	        "LoadGroupFor": {
	          "type": "IfcStructuralAnalysisModel",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralLoadLinearForce": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralLoadStatic"
	      ],
	      "fields": {
	        "LinearForceX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearForceXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearForceY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearForceYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearForceZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearForceZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearMomentX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearMomentXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearMomentY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearMomentYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LinearMomentZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LinearMomentZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralLoadPlanarForce": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralLoadStatic"
	      ],
	      "fields": {
	        "PlanarForceX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PlanarForceXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PlanarForceY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PlanarForceYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PlanarForceZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PlanarForceZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralLoadSingleDisplacement": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralLoadStatic"
	      ],
	      "fields": {
	        "DisplacementX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DisplacementXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DisplacementY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DisplacementYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DisplacementZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DisplacementZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalDisplacementRX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalDisplacementRXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalDisplacementRY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalDisplacementRYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "RotationalDisplacementRZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RotationalDisplacementRZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralLoadSingleDisplacementDistortion": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralLoadSingleDisplacement"
	      ],
	      "fields": {
	        "Distortion": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DistortionAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralLoadSingleForce": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralLoadStatic"
	      ],
	      "fields": {
	        "ForceX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ForceXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ForceY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ForceYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ForceZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ForceZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MomentX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MomentXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MomentY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MomentYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MomentZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MomentZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralLoadSingleForceWarping": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralLoadSingleForce"
	      ],
	      "fields": {
	        "WarpingMoment": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WarpingMomentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralLoadStatic": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralLoad"
	      ],
	      "fields": {}
	    },
	    "IfcStructuralLoadTemperature": {
	      "domain": "ifcstructuralloadresource",
	      "superclasses": [
	        "IfcStructuralLoadStatic"
	      ],
	      "fields": {
	        "DeltaT_Constant": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DeltaT_ConstantAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DeltaT_Y": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DeltaT_YAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DeltaT_Z": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DeltaT_ZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralMember": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralItem"
	      ],
	      "fields": {
	        "ReferencesElement": {
	          "type": "IfcRelConnectsStructuralElement",
	          "reference": true,
	          "many": true
	        },
	        "ConnectedBy": {
	          "type": "IfcRelConnectsStructuralMember",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralPlanarAction": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralAction"
	      ],
	      "fields": {
	        "ProjectedOrTrue": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralPlanarActionVarying": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralPlanarAction"
	      ],
	      "fields": {
	        "VaryingAppliedLoadLocation": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        },
	        "SubsequentAppliedLoads": {
	          "type": "IfcStructuralLoad",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralPointAction": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralAction"
	      ],
	      "fields": {}
	    },
	    "IfcStructuralPointConnection": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralConnection"
	      ],
	      "fields": {}
	    },
	    "IfcStructuralPointReaction": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralReaction"
	      ],
	      "fields": {}
	    },
	    "IfcStructuralProfileProperties": {
	      "domain": "ifcprofilepropertyresource",
	      "superclasses": [
	        "IfcGeneralProfileProperties"
	      ],
	      "fields": {
	        "TorsionalConstantX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TorsionalConstantXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MomentOfInertiaYZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MomentOfInertiaYZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MomentOfInertiaY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MomentOfInertiaYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MomentOfInertiaZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MomentOfInertiaZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WarpingConstant": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WarpingConstantAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShearCentreZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ShearCentreZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShearCentreY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ShearCentreYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShearDeformationAreaZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ShearDeformationAreaZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShearDeformationAreaY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ShearDeformationAreaYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MaximumSectionModulusY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MaximumSectionModulusYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MinimumSectionModulusY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MinimumSectionModulusYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MaximumSectionModulusZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MaximumSectionModulusZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MinimumSectionModulusZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MinimumSectionModulusZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TorsionalSectionModulus": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TorsionalSectionModulusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralReaction": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralActivity"
	      ],
	      "fields": {
	        "Causes": {
	          "type": "IfcStructuralAction",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralResultGroup": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcGroup"
	      ],
	      "fields": {
	        "TheoryType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ResultForLoadGroup": {
	          "type": "IfcStructuralLoadGroup",
	          "reference": true,
	          "many": false
	        },
	        "IsLinear": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ResultGroupFor": {
	          "type": "IfcStructuralAnalysisModel",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcStructuralSteelProfileProperties": {
	      "domain": "ifcprofilepropertyresource",
	      "superclasses": [
	        "IfcStructuralProfileProperties"
	      ],
	      "fields": {
	        "ShearAreaZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ShearAreaZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShearAreaY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ShearAreaYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PlasticShapeFactorY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PlasticShapeFactorYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PlasticShapeFactorZ": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PlasticShapeFactorZAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralSurfaceConnection": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralConnection"
	      ],
	      "fields": {}
	    },
	    "IfcStructuralSurfaceMember": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralMember"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Thickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuralSurfaceMemberVarying": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [
	        "IfcStructuralSurfaceMember"
	      ],
	      "fields": {
	        "SubsequentThickness": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "SubsequentThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "VaryingThicknessLocation": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        },
	        "VaryingThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "VaryingThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStructuredDimensionCallout": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcDraughtingCallout"
	      ],
	      "fields": {}
	    },
	    "IfcStyleModel": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcRepresentation"
	      ],
	      "fields": {}
	    },
	    "IfcStyledItem": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcRepresentationItem"
	      ],
	      "fields": {
	        "Item": {
	          "type": "IfcRepresentationItem",
	          "reference": true,
	          "many": false
	        },
	        "Styles": {
	          "type": "IfcPresentationStyleAssignment",
	          "reference": true,
	          "many": true
	        },
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcStyledRepresentation": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcStyleModel"
	      ],
	      "fields": {}
	    },
	    "IfcSubContractResource": {
	      "domain": "ifcconstructionmgmtdomain",
	      "superclasses": [
	        "IfcConstructionResource"
	      ],
	      "fields": {
	        "SubContractor": {
	          "type": "IfcActorSelect",
	          "reference": true,
	          "many": false
	        },
	        "JobDescription": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSubedge": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcEdge"
	      ],
	      "fields": {
	        "ParentEdge": {
	          "type": "IfcEdge",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSurface": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcGeometricSetSelect",
	        "IfcSurfaceOrFaceSurface"
	      ],
	      "fields": {}
	    },
	    "IfcSurfaceCurveSweptAreaSolid": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcSweptAreaSolid"
	      ],
	      "fields": {
	        "Directrix": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "StartParam": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "StartParamAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EndParam": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EndParamAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ReferenceSurface": {
	          "type": "IfcSurface",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSurfaceOfLinearExtrusion": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcSweptSurface"
	      ],
	      "fields": {
	        "ExtrudedDirection": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        },
	        "Depth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSurfaceOfRevolution": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcSweptSurface"
	      ],
	      "fields": {
	        "AxisPosition": {
	          "type": "IfcAxis1Placement",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSurfaceStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcPresentationStyle",
	        "IfcPresentationStyleSelect"
	      ],
	      "fields": {
	        "Side": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Styles": {
	          "type": "IfcSurfaceStyleElementSelect",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcSurfaceStyleLighting": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSurfaceStyleElementSelect"
	      ],
	      "fields": {
	        "DiffuseTransmissionColour": {
	          "type": "IfcColourRgb",
	          "reference": true,
	          "many": false
	        },
	        "DiffuseReflectionColour": {
	          "type": "IfcColourRgb",
	          "reference": true,
	          "many": false
	        },
	        "TransmissionColour": {
	          "type": "IfcColourRgb",
	          "reference": true,
	          "many": false
	        },
	        "ReflectanceColour": {
	          "type": "IfcColourRgb",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSurfaceStyleRefraction": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSurfaceStyleElementSelect"
	      ],
	      "fields": {
	        "RefractionIndex": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RefractionIndexAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DispersionFactor": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DispersionFactorAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSurfaceStyleRendering": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSurfaceStyleShading"
	      ],
	      "fields": {
	        "Transparency": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TransparencyAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DiffuseColour": {
	          "type": "IfcColourOrFactor",
	          "reference": true,
	          "many": false
	        },
	        "TransmissionColour": {
	          "type": "IfcColourOrFactor",
	          "reference": true,
	          "many": false
	        },
	        "DiffuseTransmissionColour": {
	          "type": "IfcColourOrFactor",
	          "reference": true,
	          "many": false
	        },
	        "ReflectionColour": {
	          "type": "IfcColourOrFactor",
	          "reference": true,
	          "many": false
	        },
	        "SpecularColour": {
	          "type": "IfcColourOrFactor",
	          "reference": true,
	          "many": false
	        },
	        "SpecularHighlight": {
	          "type": "IfcSpecularHighlightSelect",
	          "reference": true,
	          "many": false
	        },
	        "ReflectanceMethod": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSurfaceStyleShading": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSurfaceStyleElementSelect"
	      ],
	      "fields": {
	        "SurfaceColour": {
	          "type": "IfcColourRgb",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSurfaceStyleWithTextures": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSurfaceStyleElementSelect"
	      ],
	      "fields": {
	        "Textures": {
	          "type": "IfcSurfaceTexture",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcSurfaceTexture": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {
	        "RepeatS": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "RepeatT": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "TextureType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "TextureTransform": {
	          "type": "IfcCartesianTransformationOperator2D",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSweptAreaSolid": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcSolidModel"
	      ],
	      "fields": {
	        "SweptArea": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": false
	        },
	        "Position": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSweptDiskSolid": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [
	        "IfcSolidModel"
	      ],
	      "fields": {
	        "Directrix": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "Radius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "RadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "InnerRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "InnerRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "StartParam": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "StartParamAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EndParam": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EndParamAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSweptSurface": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcSurface"
	      ],
	      "fields": {
	        "SweptCurve": {
	          "type": "IfcProfileDef",
	          "reference": true,
	          "many": false
	        },
	        "Position": {
	          "type": "IfcAxis2Placement3D",
	          "reference": true,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSwitchingDeviceType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcFlowControllerType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSymbolStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcPresentationStyle",
	        "IfcPresentationStyleSelect"
	      ],
	      "fields": {
	        "StyleOfSymbol": {
	          "type": "IfcSymbolStyleSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcSystem": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcGroup"
	      ],
	      "fields": {
	        "ServicesBuildings": {
	          "type": "IfcRelServicesBuildings",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcSystemFurnitureElementType": {
	      "domain": "ifcsharedfacilitieselements",
	      "superclasses": [
	        "IfcFurnishingElementType"
	      ],
	      "fields": {}
	    },
	    "IfcTShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "Depth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WebThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WebThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeEdgeRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeEdgeRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WebEdgeRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WebEdgeRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WebSlope": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WebSlopeAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeSlope": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeSlopeAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInY": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInYAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTable": {
	      "domain": "ifcutilityresource",
	      "superclasses": [
	        "IfcMetricValueSelect"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Rows": {
	          "type": "IfcTableRow",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcTableRow": {
	      "domain": "ifcutilityresource",
	      "superclasses": [],
	      "fields": {
	        "RowCells": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": true
	        },
	        "IsHeading": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "OfTable": {
	          "type": "IfcTable",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTankType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowStorageDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTask": {
	      "domain": "ifcprocessextension",
	      "superclasses": [
	        "IfcProcess"
	      ],
	      "fields": {
	        "TaskId": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Status": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WorkMethod": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "IsMilestone": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Priority": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTelecomAddress": {
	      "domain": "ifcactorresource",
	      "superclasses": [
	        "IfcAddress"
	      ],
	      "fields": {
	        "TelephoneNumbers": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "FacsimileNumbers": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "PagerNumber": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ElectronicMailAddresses": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "WWWHomePageURL": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTendon": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcReinforcingElement"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "NominalDiameter": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "NominalDiameterAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CrossSectionArea": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CrossSectionAreaAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TensionForce": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TensionForceAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PreStress": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PreStressAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FrictionCoefficient": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FrictionCoefficientAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AnchorageSlip": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "AnchorageSlipAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MinCurvatureRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MinCurvatureRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTendonAnchor": {
	      "domain": "ifcstructuralelementsdomain",
	      "superclasses": [
	        "IfcReinforcingElement"
	      ],
	      "fields": {}
	    },
	    "IfcTerminatorSymbol": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [
	        "IfcAnnotationSymbolOccurrence"
	      ],
	      "fields": {
	        "AnnotatedCurve": {
	          "type": "IfcAnnotationCurveOccurrence",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTextLiteral": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem"
	      ],
	      "fields": {
	        "Literal": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Placement": {
	          "type": "IfcAxis2Placement",
	          "reference": true,
	          "many": false
	        },
	        "Path": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTextLiteralWithExtent": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcTextLiteral"
	      ],
	      "fields": {
	        "Extent": {
	          "type": "IfcPlanarExtent",
	          "reference": true,
	          "many": false
	        },
	        "BoxAlignment": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTextStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcPresentationStyle",
	        "IfcPresentationStyleSelect"
	      ],
	      "fields": {
	        "TextCharacterAppearance": {
	          "type": "IfcCharacterStyleSelect",
	          "reference": true,
	          "many": false
	        },
	        "TextStyle": {
	          "type": "IfcTextStyleSelect",
	          "reference": true,
	          "many": false
	        },
	        "TextFontStyle": {
	          "type": "IfcTextFontSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTextStyleFontModel": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcPreDefinedTextFont"
	      ],
	      "fields": {
	        "FontFamily": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        },
	        "FontStyle": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FontVariant": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FontWeight": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FontSize": {
	          "type": "IfcSizeSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTextStyleForDefinedFont": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcCharacterStyleSelect"
	      ],
	      "fields": {
	        "Colour": {
	          "type": "IfcColour",
	          "reference": true,
	          "many": false
	        },
	        "BackgroundColour": {
	          "type": "IfcColour",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTextStyleTextModel": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcTextStyleSelect"
	      ],
	      "fields": {
	        "TextIndent": {
	          "type": "IfcSizeSelect",
	          "reference": true,
	          "many": false
	        },
	        "TextAlign": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TextDecoration": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LetterSpacing": {
	          "type": "IfcSizeSelect",
	          "reference": true,
	          "many": false
	        },
	        "WordSpacing": {
	          "type": "IfcSizeSelect",
	          "reference": true,
	          "many": false
	        },
	        "TextTransform": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LineHeight": {
	          "type": "IfcSizeSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTextStyleWithBoxCharacteristics": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcTextStyleSelect"
	      ],
	      "fields": {
	        "BoxHeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BoxHeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BoxWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BoxWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BoxSlantAngle": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BoxSlantAngleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BoxRotateAngle": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BoxRotateAngleAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CharacterSpacing": {
	          "type": "IfcSizeSelect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTextureCoordinate": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [],
	      "fields": {
	        "AnnotatedSurface": {
	          "type": "IfcAnnotationSurface",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcTextureCoordinateGenerator": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcTextureCoordinate"
	      ],
	      "fields": {
	        "Mode": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Parameter": {
	          "type": "IfcSimpleValue",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcTextureMap": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcTextureCoordinate"
	      ],
	      "fields": {
	        "TextureMaps": {
	          "type": "IfcVertexBasedTextureMap",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcTextureVertex": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [],
	      "fields": {
	        "Coordinates": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "CoordinatesAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        }
	      }
	    },
	    "IfcThermalMaterialProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "SpecificHeatCapacity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SpecificHeatCapacityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "BoilingPoint": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BoilingPointAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FreezingPoint": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FreezingPointAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ThermalConductivity": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ThermalConductivityAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTimeSeries": {
	      "domain": "ifctimeseriesresource",
	      "superclasses": [
	        "IfcMetricValueSelect",
	        "IfcObjectReferenceSelect"
	      ],
	      "fields": {
	        "Name": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Description": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "StartTime": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "EndTime": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "TimeSeriesDataType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "DataOrigin": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedDataOrigin": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Unit": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": false
	        },
	        "DocumentedBy": {
	          "type": "IfcTimeSeriesReferenceRelationship",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcTimeSeriesReferenceRelationship": {
	      "domain": "ifctimeseriesresource",
	      "superclasses": [],
	      "fields": {
	        "ReferencedTimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        },
	        "TimeSeriesReferences": {
	          "type": "IfcDocumentSelect",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcTimeSeriesSchedule": {
	      "domain": "ifccontrolextension",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "ApplicableDates": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": true
	        },
	        "TimeSeriesScheduleType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "TimeSeries": {
	          "type": "IfcTimeSeries",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTimeSeriesValue": {
	      "domain": "ifctimeseriesresource",
	      "superclasses": [],
	      "fields": {
	        "ListValues": {
	          "type": "IfcValue",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcTopologicalRepresentationItem": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcRepresentationItem"
	      ],
	      "fields": {}
	    },
	    "IfcTopologyRepresentation": {
	      "domain": "ifcrepresentationresource",
	      "superclasses": [
	        "IfcShapeModel"
	      ],
	      "fields": {}
	    },
	    "IfcTransformerType": {
	      "domain": "ifcelectricaldomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTransportElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {
	        "OperationType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "CapacityByWeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CapacityByWeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CapacityByNumber": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CapacityByNumberAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTransportElementType": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTrapeziumProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "BottomXDim": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "BottomXDimAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TopXDim": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TopXDimAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "YDim": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "YDimAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TopXOffset": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TopXOffsetAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTrimmedCurve": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcBoundedCurve"
	      ],
	      "fields": {
	        "BasisCurve": {
	          "type": "IfcCurve",
	          "reference": true,
	          "many": false
	        },
	        "Trim1": {
	          "type": "IfcTrimmingSelect",
	          "reference": true,
	          "many": true
	        },
	        "Trim2": {
	          "type": "IfcTrimmingSelect",
	          "reference": true,
	          "many": true
	        },
	        "SenseAgreement": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "MasterRepresentation": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTubeBundleType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTwoDirectionRepeatFactor": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcOneDirectionRepeatFactor"
	      ],
	      "fields": {
	        "SecondRepeatFactor": {
	          "type": "IfcVector",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcTypeObject": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcObjectDefinition"
	      ],
	      "fields": {
	        "ApplicableOccurrence": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "HasPropertySets": {
	          "type": "IfcPropertySetDefinition",
	          "reference": true,
	          "many": true
	        },
	        "ObjectTypeOf": {
	          "type": "IfcRelDefinesByType",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcTypeProduct": {
	      "domain": "ifckernel",
	      "superclasses": [
	        "IfcTypeObject"
	      ],
	      "fields": {
	        "RepresentationMaps": {
	          "type": "IfcRepresentationMap",
	          "reference": true,
	          "many": true
	        },
	        "Tag": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcUShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "Depth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WebThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WebThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EdgeRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EdgeRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeSlope": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeSlopeAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInX": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "CentreOfGravityInXAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcUnitAssignment": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [],
	      "fields": {
	        "Units": {
	          "type": "IfcUnit",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcUnitaryEquipmentType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcEnergyConversionDeviceType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcValveType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcFlowControllerType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcVector": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [
	        "IfcGeometricRepresentationItem",
	        "IfcVectorOrDirection"
	      ],
	      "fields": {
	        "Orientation": {
	          "type": "IfcDirection",
	          "reference": true,
	          "many": false
	        },
	        "Magnitude": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MagnitudeAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Dim": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcVertex": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcTopologicalRepresentationItem"
	      ],
	      "fields": {}
	    },
	    "IfcVertexBasedTextureMap": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [],
	      "fields": {
	        "TextureVertices": {
	          "type": "IfcTextureVertex",
	          "reference": true,
	          "many": true
	        },
	        "TexturePoints": {
	          "type": "IfcCartesianPoint",
	          "reference": true,
	          "many": true
	        }
	      }
	    },
	    "IfcVertexLoop": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcLoop"
	      ],
	      "fields": {
	        "LoopVertex": {
	          "type": "IfcVertex",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcVertexPoint": {
	      "domain": "ifctopologyresource",
	      "superclasses": [
	        "IfcVertex",
	        "IfcPointOrVertexPoint"
	      ],
	      "fields": {
	        "VertexGeometry": {
	          "type": "IfcPoint",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcVibrationIsolatorType": {
	      "domain": "ifchvacdomain",
	      "superclasses": [
	        "IfcDiscreteAccessoryType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcVirtualElement": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcElement"
	      ],
	      "fields": {}
	    },
	    "IfcVirtualGridIntersection": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [],
	      "fields": {
	        "IntersectingAxes": {
	          "type": "IfcGridAxis",
	          "reference": true,
	          "many": true
	        },
	        "OffsetDistances": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "OffsetDistancesAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        }
	      }
	    },
	    "IfcWall": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {}
	    },
	    "IfcWallStandardCase": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcWall"
	      ],
	      "fields": {}
	    },
	    "IfcWallType": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElementType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcWasteTerminalType": {
	      "domain": "ifcplumbingfireprotectiondomain",
	      "superclasses": [
	        "IfcFlowTerminalType"
	      ],
	      "fields": {
	        "PredefinedType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcWaterProperties": {
	      "domain": "ifcmaterialpropertyresource",
	      "superclasses": [
	        "IfcMaterialProperties"
	      ],
	      "fields": {
	        "IsPotable": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Hardness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "HardnessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AlkalinityConcentration": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "AlkalinityConcentrationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "AcidityConcentration": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "AcidityConcentrationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ImpuritiesContent": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "ImpuritiesContentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "PHLevel": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "PHLevelAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "DissolvedSolidsContent": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DissolvedSolidsContentAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcWindow": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcBuildingElement"
	      ],
	      "fields": {
	        "OverallHeight": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OverallHeightAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "OverallWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "OverallWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcWindowLiningProperties": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "LiningDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LiningDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "LiningThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "LiningThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TransomThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TransomThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "MullionThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "MullionThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FirstTransomOffset": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FirstTransomOffsetAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SecondTransomOffset": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SecondTransomOffsetAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FirstMullionOffset": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FirstMullionOffsetAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "SecondMullionOffset": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "SecondMullionOffsetAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShapeAspectStyle": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcWindowPanelProperties": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcPropertySetDefinition"
	      ],
	      "fields": {
	        "OperationType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "PanelPosition": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "FrameDepth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FrameDepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FrameThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FrameThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "ShapeAspectStyle": {
	          "type": "IfcShapeAspect",
	          "reference": true,
	          "many": false
	        }
	      }
	    },
	    "IfcWindowStyle": {
	      "domain": "ifcsharedbldgelements",
	      "superclasses": [
	        "IfcTypeProduct"
	      ],
	      "fields": {
	        "ConstructionType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "OperationType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "ParameterTakesPrecedence": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "Sizeable": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcWorkControl": {
	      "domain": "ifcprocessextension",
	      "superclasses": [
	        "IfcControl"
	      ],
	      "fields": {
	        "Identifier": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "CreationDate": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "Creators": {
	          "type": "IfcPerson",
	          "reference": true,
	          "many": true
	        },
	        "Purpose": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "Duration": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DurationAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "TotalFloat": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "TotalFloatAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "StartTime": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "FinishTime": {
	          "type": "IfcDateTimeSelect",
	          "reference": true,
	          "many": false
	        },
	        "WorkControlType": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        },
	        "UserDefinedControlType": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcWorkPlan": {
	      "domain": "ifcprocessextension",
	      "superclasses": [
	        "IfcWorkControl"
	      ],
	      "fields": {}
	    },
	    "IfcWorkSchedule": {
	      "domain": "ifcprocessextension",
	      "superclasses": [
	        "IfcWorkControl"
	      ],
	      "fields": {}
	    },
	    "IfcZShapeProfileDef": {
	      "domain": "ifcprofileresource",
	      "superclasses": [
	        "IfcParameterizedProfileDef"
	      ],
	      "fields": {
	        "Depth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "DepthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeWidth": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeWidthAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "WebThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "WebThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FlangeThickness": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FlangeThicknessAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "FilletRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        },
	        "EdgeRadius": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "EdgeRadiusAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcZone": {
	      "domain": "ifcproductextension",
	      "superclasses": [
	        "IfcGroup"
	      ],
	      "fields": {}
	    },
	    "IfcAbsorbedDoseMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAccelerationMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAmountOfSubstanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAngularVelocityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcAreaMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoolean": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcSimpleValue",
	        "IfcValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcContextDependentMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCountMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcCurvatureMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDayInMonthNumber": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDaylightSavingHour": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDescriptiveMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue",
	        "IfcSizeSelect"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDimensionCount": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDoseEquivalentMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcDynamicViscosityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricCapacitanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricChargeMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricConductanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricCurrentMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricResistanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcElectricVoltageMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcEnergyMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFontStyle": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFontVariant": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFontWeight": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcForceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcFrequencyMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcGloballyUniqueId": {
	      "domain": "ifcutilityresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcHeatFluxDensityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcHeatingValueMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcHourInDay": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcIdentifier": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcSimpleValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcIlluminanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcInductanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcInteger": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcSimpleValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcIntegerCountRateMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcIonConcentrationMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcIsothermalMoistureCapacityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcKinematicViscosityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLabel": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcConditionCriterionSelect",
	        "IfcSimpleValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLengthMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue",
	        "IfcSizeSelect"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLinearForceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLinearMomentMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLinearStiffnessMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLinearVelocityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLogical": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcSimpleValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLuminousFluxMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLuminousIntensityDistributionMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcLuminousIntensityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMagneticFluxDensityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMagneticFluxMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMassDensityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMassFlowRateMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMassMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMassPerLengthMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMinuteInHour": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcModulusOfElasticityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcModulusOfLinearSubgradeReactionMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcModulusOfRotationalSubgradeReactionMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcModulusOfSubgradeReactionMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMoistureDiffusivityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMolecularWeightMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMomentOfInertiaMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMonetaryMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcAppliedValueSelect",
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcMonthInYearNumber": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcNumericMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPHMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcParameterValue": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue",
	        "IfcTrimmingSelect"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPlanarForceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPlaneAngleMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue",
	        "IfcOrientationSelect"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPowerMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPresentableText": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcPressureMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRadioActivityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRatioMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcAppliedValueSelect",
	        "IfcMeasureValue",
	        "IfcSizeSelect"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcReal": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcSimpleValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRotationalFrequencyMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRotationalMassMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcRotationalStiffnessMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSecondInMinute": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSectionModulusMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSectionalAreaIntegralMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcShearModulusMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSolidAngleMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSoundPowerMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSoundPressureMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSpecificHeatCapacityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSpecularExponent": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSpecularHighlightSelect"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcSpecularRoughness": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcSpecularHighlightSelect"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTemperatureGradientMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcText": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMetricValueSelect",
	        "IfcSimpleValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTextAlignment": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTextDecoration": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTextFontName": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTextTransformation": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcThermalAdmittanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcThermalConductivityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcThermalExpansionCoefficientMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcThermalResistanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcThermalTransmittanceMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcThermodynamicTemperatureMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTimeMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTimeStamp": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcTorqueMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcVaporPermeabilityMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcVolumeMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcVolumetricFlowRateMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcWarpingConstantMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcWarpingMomentMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": false
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcYearNumber": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcBoxAlignment": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [
	        "IfcLabel"
	      ],
	      "fields": {}
	    },
	    "IfcCompoundPlaneAngleMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcDerivedMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "int",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcNormalisedRatioMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcRatioMeasure",
	        "IfcColourOrFactor",
	        "IfcMeasureValue",
	        "IfcSizeSelect"
	      ],
	      "fields": {}
	    },
	    "IfcPositiveLengthMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcLengthMeasure",
	        "IfcHatchLineDistanceSelect",
	        "IfcMeasureValue",
	        "IfcSizeSelect"
	      ],
	      "fields": {}
	    },
	    "IfcPositivePlaneAngleMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcPlaneAngleMeasure",
	        "IfcMeasureValue"
	      ],
	      "fields": {}
	    },
	    "IfcPositiveRatioMeasure": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcRatioMeasure",
	        "IfcMeasureValue",
	        "IfcSizeSelect"
	      ],
	      "fields": {}
	    },
	    "IfcActionSourceTypeEnum": {},
	    "IfcActionTypeEnum": {},
	    "IfcActuatorTypeEnum": {},
	    "IfcAddressTypeEnum": {},
	    "IfcAheadOrBehind": {},
	    "IfcAirTerminalBoxTypeEnum": {},
	    "IfcAirTerminalTypeEnum": {},
	    "IfcAirToAirHeatRecoveryTypeEnum": {},
	    "IfcAlarmTypeEnum": {},
	    "IfcAnalysisModelTypeEnum": {},
	    "IfcAnalysisTheoryTypeEnum": {},
	    "IfcArithmeticOperatorEnum": {},
	    "IfcAssemblyPlaceEnum": {},
	    "IfcBSplineCurveForm": {},
	    "IfcBeamTypeEnum": {},
	    "IfcBenchmarkEnum": {},
	    "IfcBoilerTypeEnum": {},
	    "IfcBooleanOperator": {},
	    "IfcBuildingElementProxyTypeEnum": {},
	    "IfcCableCarrierFittingTypeEnum": {},
	    "IfcCableCarrierSegmentTypeEnum": {},
	    "IfcCableSegmentTypeEnum": {},
	    "IfcChangeActionEnum": {},
	    "IfcChillerTypeEnum": {},
	    "IfcCoilTypeEnum": {},
	    "IfcColumnTypeEnum": {},
	    "IfcCompressorTypeEnum": {},
	    "IfcCondenserTypeEnum": {},
	    "IfcConnectionTypeEnum": {},
	    "IfcConstraintEnum": {},
	    "IfcControllerTypeEnum": {},
	    "IfcCooledBeamTypeEnum": {},
	    "IfcCoolingTowerTypeEnum": {},
	    "IfcCostScheduleTypeEnum": {},
	    "IfcCoveringTypeEnum": {},
	    "IfcCurrencyEnum": {},
	    "IfcCurtainWallTypeEnum": {},
	    "IfcDamperTypeEnum": {},
	    "IfcDataOriginEnum": {},
	    "IfcDerivedUnitEnum": {},
	    "IfcDimensionExtentUsage": {},
	    "IfcDirectionSenseEnum": {},
	    "IfcDistributionChamberElementTypeEnum": {},
	    "IfcDocumentConfidentialityEnum": {},
	    "IfcDocumentStatusEnum": {},
	    "IfcDoorPanelOperationEnum": {},
	    "IfcDoorPanelPositionEnum": {},
	    "IfcDoorStyleConstructionEnum": {},
	    "IfcDoorStyleOperationEnum": {},
	    "IfcDuctFittingTypeEnum": {},
	    "IfcDuctSegmentTypeEnum": {},
	    "IfcDuctSilencerTypeEnum": {},
	    "IfcElectricApplianceTypeEnum": {},
	    "IfcElectricCurrentEnum": {},
	    "IfcElectricDistributionPointFunctionEnum": {},
	    "IfcElectricFlowStorageDeviceTypeEnum": {},
	    "IfcElectricGeneratorTypeEnum": {},
	    "IfcElectricHeaterTypeEnum": {},
	    "IfcElectricMotorTypeEnum": {},
	    "IfcElectricTimeControlTypeEnum": {},
	    "IfcElementAssemblyTypeEnum": {},
	    "IfcElementCompositionEnum": {},
	    "IfcEnergySequenceEnum": {},
	    "IfcEnvironmentalImpactCategoryEnum": {},
	    "IfcEvaporativeCoolerTypeEnum": {},
	    "IfcEvaporatorTypeEnum": {},
	    "IfcFanTypeEnum": {},
	    "IfcFilterTypeEnum": {},
	    "IfcFireSuppressionTerminalTypeEnum": {},
	    "IfcFlowDirectionEnum": {},
	    "IfcFlowInstrumentTypeEnum": {},
	    "IfcFlowMeterTypeEnum": {},
	    "IfcFootingTypeEnum": {},
	    "IfcGasTerminalTypeEnum": {},
	    "IfcGeometricProjectionEnum": {},
	    "IfcGlobalOrLocalEnum": {},
	    "IfcHeatExchangerTypeEnum": {},
	    "IfcHumidifierTypeEnum": {},
	    "IfcInternalOrExternalEnum": {},
	    "IfcInventoryTypeEnum": {},
	    "IfcJunctionBoxTypeEnum": {},
	    "IfcLampTypeEnum": {},
	    "IfcLayerSetDirectionEnum": {},
	    "IfcLightDistributionCurveEnum": {},
	    "IfcLightEmissionSourceEnum": {},
	    "IfcLightFixtureTypeEnum": {},
	    "IfcLoadGroupTypeEnum": {},
	    "IfcLogicalOperatorEnum": {},
	    "IfcMemberTypeEnum": {},
	    "IfcMotorConnectionTypeEnum": {},
	    "IfcNullStyleEnum": {},
	    "IfcObjectTypeEnum": {},
	    "IfcObjectiveEnum": {},
	    "IfcOccupantTypeEnum": {},
	    "IfcOutletTypeEnum": {},
	    "IfcPermeableCoveringOperationEnum": {},
	    "IfcPhysicalOrVirtualEnum": {},
	    "IfcPileConstructionEnum": {},
	    "IfcPileTypeEnum": {},
	    "IfcPipeFittingTypeEnum": {},
	    "IfcPipeSegmentTypeEnum": {},
	    "IfcPlateTypeEnum": {},
	    "IfcProcedureTypeEnum": {},
	    "IfcProfileTypeEnum": {},
	    "IfcProjectOrderRecordTypeEnum": {},
	    "IfcProjectOrderTypeEnum": {},
	    "IfcProjectedOrTrueLengthEnum": {},
	    "IfcPropertySourceEnum": {},
	    "IfcProtectiveDeviceTypeEnum": {},
	    "IfcPumpTypeEnum": {},
	    "IfcRailingTypeEnum": {},
	    "IfcRampFlightTypeEnum": {},
	    "IfcRampTypeEnum": {},
	    "IfcReflectanceMethodEnum": {},
	    "IfcReinforcingBarRoleEnum": {},
	    "IfcReinforcingBarSurfaceEnum": {},
	    "IfcResourceConsumptionEnum": {},
	    "IfcRibPlateDirectionEnum": {},
	    "IfcRoleEnum": {},
	    "IfcRoofTypeEnum": {},
	    "IfcSIPrefix": {},
	    "IfcSIUnitName": {},
	    "IfcSanitaryTerminalTypeEnum": {},
	    "IfcSectionTypeEnum": {},
	    "IfcSensorTypeEnum": {},
	    "IfcSequenceEnum": {},
	    "IfcServiceLifeFactorTypeEnum": {},
	    "IfcServiceLifeTypeEnum": {},
	    "IfcSlabTypeEnum": {},
	    "IfcSoundScaleEnum": {},
	    "IfcSpaceHeaterTypeEnum": {},
	    "IfcSpaceTypeEnum": {},
	    "IfcStackTerminalTypeEnum": {},
	    "IfcStairFlightTypeEnum": {},
	    "IfcStairTypeEnum": {},
	    "IfcStateEnum": {},
	    "IfcStructuralCurveTypeEnum": {},
	    "IfcStructuralSurfaceTypeEnum": {},
	    "IfcSurfaceSide": {},
	    "IfcSurfaceTextureEnum": {},
	    "IfcSwitchingDeviceTypeEnum": {},
	    "IfcTankTypeEnum": {},
	    "IfcTendonTypeEnum": {},
	    "IfcTextPath": {},
	    "IfcThermalLoadSourceEnum": {},
	    "IfcThermalLoadTypeEnum": {},
	    "IfcTimeSeriesDataTypeEnum": {},
	    "IfcTimeSeriesScheduleTypeEnum": {},
	    "IfcTransformerTypeEnum": {},
	    "IfcTransitionCode": {},
	    "IfcTransportElementTypeEnum": {},
	    "IfcTrimmingPreference": {},
	    "IfcTubeBundleTypeEnum": {},
	    "IfcUnitEnum": {},
	    "IfcUnitaryEquipmentTypeEnum": {},
	    "IfcValveTypeEnum": {},
	    "IfcVibrationIsolatorTypeEnum": {},
	    "IfcWallTypeEnum": {},
	    "IfcWasteTerminalTypeEnum": {},
	    "IfcWindowPanelOperationEnum": {},
	    "IfcWindowPanelPositionEnum": {},
	    "IfcWindowStyleConstructionEnum": {},
	    "IfcWindowStyleOperationEnum": {},
	    "IfcWorkControlTypeEnum": {},
	    "IfcComplexNumber": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcMeasureValue"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "double",
	          "reference": false,
	          "many": true
	        },
	        "wrappedValueAsString": {
	          "type": "string",
	          "reference": false,
	          "many": true
	        }
	      }
	    },
	    "IfcNullStyle": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcPresentationStyleSelect"
	      ],
	      "fields": {
	        "wrappedValue": {
	          "type": "enum",
	          "reference": false,
	          "many": false
	        }
	      }
	    },
	    "IfcActorSelect": {
	      "domain": "ifcactorresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcAppliedValueSelect": {
	      "domain": "ifccostresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcAxis2Placement": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcBooleanOperand": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcCharacterStyleSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcClassificationNotationSelect": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcColour": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [
	        "IfcFillStyleSelect",
	        "IfcSymbolStyleSelect"
	      ],
	      "fields": {}
	    },
	    "IfcColourOrFactor": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcConditionCriterionSelect": {
	      "domain": "ifcfacilitiesmgmtdomain",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcCsgSelect": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcCurveFontOrScaledCurveFontSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcCurveOrEdgeCurve": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcCurveStyleFontSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [
	        "IfcCurveFontOrScaledCurveFontSelect"
	      ],
	      "fields": {}
	    },
	    "IfcDateTimeSelect": {
	      "domain": "ifcdatetimeresource",
	      "superclasses": [
	        "IfcMetricValueSelect"
	      ],
	      "fields": {}
	    },
	    "IfcDefinedSymbolSelect": {
	      "domain": "ifcpresentationdefinitionresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcDerivedMeasureValue": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcValue"
	      ],
	      "fields": {}
	    },
	    "IfcDocumentSelect": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcDraughtingCalloutElement": {
	      "domain": "ifcpresentationdimensioningresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcFillAreaStyleTileShapeSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcFillStyleSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcGeometricSetSelect": {
	      "domain": "ifcgeometricmodelresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcHatchLineDistanceSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcLayeredItem": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcLibrarySelect": {
	      "domain": "ifcexternalreferenceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcLightDistributionDataSourceSelect": {
	      "domain": "ifcpresentationorganizationresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcMaterialSelect": {
	      "domain": "ifcmaterialresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcMeasureValue": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcValue"
	      ],
	      "fields": {}
	    },
	    "IfcMetricValueSelect": {
	      "domain": "ifcconstraintresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcObjectReferenceSelect": {
	      "domain": "ifcpropertyresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcOrientationSelect": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcPointOrVertexPoint": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcPresentationStyleSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcShell": {
	      "domain": "ifctopologyresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcSimpleValue": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [
	        "IfcValue"
	      ],
	      "fields": {}
	    },
	    "IfcSizeSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcSpecularHighlightSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcStructuralActivityAssignmentSelect": {
	      "domain": "ifcstructuralanalysisdomain",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcSurfaceOrFaceSurface": {
	      "domain": "ifcgeometricconstraintresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcSurfaceStyleElementSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcSymbolStyleSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcTextFontSelect": {
	      "domain": "ifcpresentationresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcTextStyleSelect": {
	      "domain": "ifcpresentationappearanceresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcTrimmingSelect": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcUnit": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcValue": {
	      "domain": "ifcmeasureresource",
	      "superclasses": [],
	      "fields": {}
	    },
	    "IfcVectorOrDirection": {
	      "domain": "ifcgeometryresource",
	      "superclasses": [],
	      "fields": {}
	    }
	  }
	}
});
define(function(){
	return {
  "classes": {
    "Tristate": {},
    "IfcActionRequest": {
      "domain": "ifcsharedmgmtelements",
      "superclasses": [
        "IfcControl"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Status": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongDescription": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcActor": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObject"
      ],
      "fields": {
        "TheActor": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "IsActingUpon": {
          "type": "IfcRelAssignsToActor",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcActorRole": {
      "domain": "ifcactorresource",
      "superclasses": [
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Role": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedRole": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasExternalReference": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcActuator": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcActuatorType": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAddress": {
      "domain": "ifcactorresource",
      "superclasses": [
        "IfcObjectReferenceSelect"
      ],
      "fields": {
        "Purpose": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "UserDefinedPurpose": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OfPerson": {
          "type": "IfcPerson",
          "reference": true,
          "many": true
        },
        "OfOrganization": {
          "type": "IfcOrganization",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcAdvancedBrep": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcManifoldSolidBrep"
      ],
      "fields": {}
    },
    "IfcAdvancedBrepWithVoids": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcAdvancedBrep"
      ],
      "fields": {
        "Voids": {
          "type": "IfcClosedShell",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcAdvancedFace": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcFaceSurface"
      ],
      "fields": {}
    },
    "IfcAirTerminal": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAirTerminalBox": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowController"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAirTerminalBoxType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowControllerType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAirTerminalType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAirToAirHeatRecovery": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAirToAirHeatRecoveryType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAlarm": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAlarmType": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAnnotation": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcProduct"
      ],
      "fields": {
        "ContainedInStructure": {
          "type": "IfcRelContainedInSpatialStructure",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcAnnotationFillArea": {
      "domain": "ifcpresentationdefinitionresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "OuterBoundary": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "InnerBoundaries": {
          "type": "IfcCurve",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcApplication": {
      "domain": "ifcutilityresource",
      "superclasses": [],
      "fields": {
        "ApplicationDeveloper": {
          "type": "IfcOrganization",
          "reference": true,
          "many": false
        },
        "Version": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ApplicationFullName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ApplicationIdentifier": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAppliedValue": {
      "domain": "ifccostresource",
      "superclasses": [
        "IfcMetricValueSelect",
        "IfcObjectReferenceSelect",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "AppliedValue": {
          "type": "IfcAppliedValueSelect",
          "reference": true,
          "many": false
        },
        "UnitBasis": {
          "type": "IfcMeasureWithUnit",
          "reference": true,
          "many": false
        },
        "ApplicableDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FixedUntilDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Category": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Condition": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ArithmeticOperator": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Components": {
          "type": "IfcAppliedValue",
          "reference": true,
          "many": true
        },
        "HasExternalReference": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcApproval": {
      "domain": "ifcapprovalresource",
      "superclasses": [
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Identifier": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TimeOfApproval": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Status": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Level": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Qualifier": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RequestingApproval": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "GivingApproval": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "HasExternalReferences": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        },
        "ApprovedObjects": {
          "type": "IfcRelAssociatesApproval",
          "reference": true,
          "many": true
        },
        "ApprovedResources": {
          "type": "IfcResourceApprovalRelationship",
          "reference": true,
          "many": true
        },
        "IsRelatedWith": {
          "type": "IfcApprovalRelationship",
          "reference": true,
          "many": true
        },
        "Relates": {
          "type": "IfcApprovalRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcApprovalRelationship": {
      "domain": "ifcapprovalresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "RelatingApproval": {
          "type": "IfcApproval",
          "reference": true,
          "many": false
        },
        "RelatedApprovals": {
          "type": "IfcApproval",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcArbitraryClosedProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcProfileDef"
      ],
      "fields": {
        "OuterCurve": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcArbitraryOpenProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcProfileDef"
      ],
      "fields": {
        "Curve": {
          "type": "IfcBoundedCurve",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcArbitraryProfileDefWithVoids": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcArbitraryClosedProfileDef"
      ],
      "fields": {
        "InnerCurves": {
          "type": "IfcCurve",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcAsset": {
      "domain": "ifcsharedfacilitieselements",
      "superclasses": [
        "IfcGroup"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OriginalValue": {
          "type": "IfcCostValue",
          "reference": true,
          "many": false
        },
        "CurrentValue": {
          "type": "IfcCostValue",
          "reference": true,
          "many": false
        },
        "TotalReplacementCost": {
          "type": "IfcCostValue",
          "reference": true,
          "many": false
        },
        "Owner": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "User": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "ResponsiblePerson": {
          "type": "IfcPerson",
          "reference": true,
          "many": false
        },
        "IncorporationDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DepreciatedValue": {
          "type": "IfcCostValue",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcAsymmetricIShapeProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "BottomFlangeWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BottomFlangeWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OverallDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OverallDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WebThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WebThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BottomFlangeThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BottomFlangeThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BottomFlangeFilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BottomFlangeFilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TopFlangeWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TopFlangeWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TopFlangeThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TopFlangeThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TopFlangeFilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TopFlangeFilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BottomFlangeEdgeRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BottomFlangeEdgeRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BottomFlangeSlope": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BottomFlangeSlopeAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TopFlangeEdgeRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TopFlangeEdgeRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TopFlangeSlope": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TopFlangeSlopeAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAudioVisualAppliance": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAudioVisualApplianceType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAxis1Placement": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcPlacement"
      ],
      "fields": {
        "Axis": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcAxis2Placement2D": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcPlacement",
        "IfcAxis2Placement"
      ],
      "fields": {
        "RefDirection": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcAxis2Placement3D": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcPlacement",
        "IfcAxis2Placement"
      ],
      "fields": {
        "Axis": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        },
        "RefDirection": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcBSplineCurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundedCurve"
      ],
      "fields": {
        "Degree": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "ControlPointsList": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": true
        },
        "CurveForm": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ClosedCurve": {
          "type": "boolean",
          "reference": false,
          "many": false
        },
        "SelfIntersect": {
          "type": "boolean",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBSplineCurveWithKnots": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBSplineCurve"
      ],
      "fields": {
        "KnotMultiplicities": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "Knots": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "KnotsAsString": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "KnotSpec": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBSplineSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundedSurface"
      ],
      "fields": {
        "UDegree": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "VDegree": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "SurfaceForm": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UClosed": {
          "type": "boolean",
          "reference": false,
          "many": false
        },
        "VClosed": {
          "type": "boolean",
          "reference": false,
          "many": false
        },
        "SelfIntersect": {
          "type": "boolean",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBSplineSurfaceWithKnots": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBSplineSurface"
      ],
      "fields": {
        "UMultiplicities": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "VMultiplicities": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "UKnots": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "UKnotsAsString": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "VKnots": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "VKnotsAsString": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "KnotSpec": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBeam": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBeamStandardCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBeam"
      ],
      "fields": {}
    },
    "IfcBeamType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBlobTexture": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcSurfaceTexture"
      ],
      "fields": {
        "RasterFormat": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RasterCode": {
          "type": "bytearray",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBlock": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcCsgPrimitive3D"
      ],
      "fields": {
        "XLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "XLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "YLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "YLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ZLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ZLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBoiler": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBoilerType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBooleanClippingResult": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcBooleanResult"
      ],
      "fields": {}
    },
    "IfcBooleanResult": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcBooleanOperand",
        "IfcCsgSelect"
      ],
      "fields": {
        "Operator": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "FirstOperand": {
          "type": "IfcBooleanOperand",
          "reference": true,
          "many": false
        },
        "SecondOperand": {
          "type": "IfcBooleanOperand",
          "reference": true,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBoundaryCondition": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBoundaryCurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCompositeCurveOnSurface"
      ],
      "fields": {}
    },
    "IfcBoundaryEdgeCondition": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcBoundaryCondition"
      ],
      "fields": {
        "TranslationalStiffnessByLengthX": {
          "type": "IfcModulusOfTranslationalSubgradeReactionSelect",
          "reference": true,
          "many": false
        },
        "TranslationalStiffnessByLengthY": {
          "type": "IfcModulusOfTranslationalSubgradeReactionSelect",
          "reference": true,
          "many": false
        },
        "TranslationalStiffnessByLengthZ": {
          "type": "IfcModulusOfTranslationalSubgradeReactionSelect",
          "reference": true,
          "many": false
        },
        "RotationalStiffnessByLengthX": {
          "type": "IfcModulusOfRotationalSubgradeReactionSelect",
          "reference": true,
          "many": false
        },
        "RotationalStiffnessByLengthY": {
          "type": "IfcModulusOfRotationalSubgradeReactionSelect",
          "reference": true,
          "many": false
        },
        "RotationalStiffnessByLengthZ": {
          "type": "IfcModulusOfRotationalSubgradeReactionSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcBoundaryFaceCondition": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcBoundaryCondition"
      ],
      "fields": {
        "TranslationalStiffnessByAreaX": {
          "type": "IfcModulusOfSubgradeReactionSelect",
          "reference": true,
          "many": false
        },
        "TranslationalStiffnessByAreaY": {
          "type": "IfcModulusOfSubgradeReactionSelect",
          "reference": true,
          "many": false
        },
        "TranslationalStiffnessByAreaZ": {
          "type": "IfcModulusOfSubgradeReactionSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcBoundaryNodeCondition": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcBoundaryCondition"
      ],
      "fields": {
        "TranslationalStiffnessX": {
          "type": "IfcTranslationalStiffnessSelect",
          "reference": true,
          "many": false
        },
        "TranslationalStiffnessY": {
          "type": "IfcTranslationalStiffnessSelect",
          "reference": true,
          "many": false
        },
        "TranslationalStiffnessZ": {
          "type": "IfcTranslationalStiffnessSelect",
          "reference": true,
          "many": false
        },
        "RotationalStiffnessX": {
          "type": "IfcRotationalStiffnessSelect",
          "reference": true,
          "many": false
        },
        "RotationalStiffnessY": {
          "type": "IfcRotationalStiffnessSelect",
          "reference": true,
          "many": false
        },
        "RotationalStiffnessZ": {
          "type": "IfcRotationalStiffnessSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcBoundaryNodeConditionWarping": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcBoundaryNodeCondition"
      ],
      "fields": {
        "WarpingStiffness": {
          "type": "IfcWarpingStiffnessSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcBoundedCurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCurve",
        "IfcCurveOrEdgeCurve"
      ],
      "fields": {}
    },
    "IfcBoundedSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcSurface"
      ],
      "fields": {}
    },
    "IfcBoundingBox": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "Corner": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": false
        },
        "XDim": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "XDimAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "YDim": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "YDimAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ZDim": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ZDimAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBoxedHalfSpace": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcHalfSpaceSolid"
      ],
      "fields": {
        "Enclosure": {
          "type": "IfcBoundingBox",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcBuilding": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialStructureElement"
      ],
      "fields": {
        "ElevationOfRefHeight": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ElevationOfRefHeightAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ElevationOfTerrain": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ElevationOfTerrainAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BuildingAddress": {
          "type": "IfcPostalAddress",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcBuildingElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {
        "HasCoverings": {
          "type": "IfcRelCoversBldgElements",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcBuildingElementPart": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementComponent"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBuildingElementPartType": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementComponentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBuildingElementProxy": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBuildingElementProxyType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBuildingElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElementType"
      ],
      "fields": {}
    },
    "IfcBuildingStorey": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialStructureElement"
      ],
      "fields": {
        "Elevation": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ElevationAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBuildingSystem": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcSystem"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBurner": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBurnerType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCShapeProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "Depth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Width": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WallThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WallThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Girth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "GirthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "InternalFilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "InternalFilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCableCarrierFitting": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowFitting"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCableCarrierFittingType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowFittingType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCableCarrierSegment": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowSegment"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCableCarrierSegmentType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowSegmentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCableFitting": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowFitting"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCableFittingType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowFittingType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCableSegment": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowSegment"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCableSegmentType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowSegmentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCartesianPoint": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcPoint",
        "IfcTrimmingSelect"
      ],
      "fields": {
        "Coordinates": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "CoordinatesAsString": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCartesianPointList": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {}
    },
    "IfcCartesianPointList3D": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcCartesianPointList"
      ],
      "fields": {}
    },
    "IfcCartesianTransformationOperator": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "Axis1": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        },
        "Axis2": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        },
        "LocalOrigin": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": false
        },
        "Scale": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ScaleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCartesianTransformationOperator2D": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCartesianTransformationOperator"
      ],
      "fields": {}
    },
    "IfcCartesianTransformationOperator2DnonUniform": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCartesianTransformationOperator2D"
      ],
      "fields": {
        "Scale2": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "Scale2AsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCartesianTransformationOperator3D": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCartesianTransformationOperator"
      ],
      "fields": {
        "Axis3": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcCartesianTransformationOperator3DnonUniform": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCartesianTransformationOperator3D"
      ],
      "fields": {
        "Scale2": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "Scale2AsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Scale3": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "Scale3AsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCenterLineProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcArbitraryOpenProfileDef"
      ],
      "fields": {
        "Thickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcChiller": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcChillerType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcChimney": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcChimneyType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCircle": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcConic"
      ],
      "fields": {
        "Radius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCircleHollowProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcCircleProfileDef"
      ],
      "fields": {
        "WallThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WallThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCircleProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "Radius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCivilElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {}
    },
    "IfcCivilElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElementType"
      ],
      "fields": {}
    },
    "IfcClassification": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcExternalInformation",
        "IfcClassificationReferenceSelect",
        "IfcClassificationSelect"
      ],
      "fields": {
        "Source": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Edition": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EditionDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Location": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ReferenceTokens": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "ClassificationForObjects": {
          "type": "IfcRelAssociatesClassification",
          "reference": true,
          "many": true
        },
        "HasReferences": {
          "type": "IfcClassificationReference",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcClassificationReference": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcExternalReference",
        "IfcClassificationReferenceSelect",
        "IfcClassificationSelect"
      ],
      "fields": {
        "ReferencedSource": {
          "type": "IfcClassificationReferenceSelect",
          "reference": true,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Sort": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ClassificationRefForObjects": {
          "type": "IfcRelAssociatesClassification",
          "reference": true,
          "many": true
        },
        "HasReferences": {
          "type": "IfcClassificationReference",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcClosedShell": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcConnectedFaceSet",
        "IfcShell",
        "IfcSolidOrShell"
      ],
      "fields": {}
    },
    "IfcCoil": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCoilType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcColourRgb": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcColourSpecification",
        "IfcColourOrFactor"
      ],
      "fields": {
        "Red": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RedAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Green": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "GreenAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Blue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BlueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcColourRgbList": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {}
    },
    "IfcColourSpecification": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem",
        "IfcColour"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcColumn": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcColumnStandardCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcColumn"
      ],
      "fields": {}
    },
    "IfcColumnType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCommunicationsAppliance": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCommunicationsApplianceType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcComplexProperty": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcProperty"
      ],
      "fields": {
        "UsageName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasProperties": {
          "type": "IfcProperty",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcComplexPropertyTemplate": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertyTemplate"
      ],
      "fields": {
        "UsageName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TemplateType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "HasPropertyTemplates": {
          "type": "IfcPropertyTemplate",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcCompositeCurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundedCurve"
      ],
      "fields": {
        "Segments": {
          "type": "IfcCompositeCurveSegment",
          "reference": true,
          "many": true
        },
        "SelfIntersect": {
          "type": "boolean",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCompositeCurveOnSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCompositeCurve",
        "IfcCurveOnSurface"
      ],
      "fields": {}
    },
    "IfcCompositeCurveSegment": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "Transition": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "SameSense": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ParentCurve": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "UsingCurves": {
          "type": "IfcCompositeCurve",
          "reference": true,
          "many": true
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCompositeProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcProfileDef"
      ],
      "fields": {
        "Profiles": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": true
        },
        "Label": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCompressor": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowMovingDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCompressorType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowMovingDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCondenser": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCondenserType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConic": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCurve"
      ],
      "fields": {
        "Position": {
          "type": "IfcAxis2Placement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcConnectedFaceSet": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcTopologicalRepresentationItem"
      ],
      "fields": {
        "CfsFaces": {
          "type": "IfcFace",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcConnectionCurveGeometry": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [
        "IfcConnectionGeometry"
      ],
      "fields": {
        "CurveOnRelatingElement": {
          "type": "IfcCurveOrEdgeCurve",
          "reference": true,
          "many": false
        },
        "CurveOnRelatedElement": {
          "type": "IfcCurveOrEdgeCurve",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcConnectionGeometry": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcConnectionPointEccentricity": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [
        "IfcConnectionPointGeometry"
      ],
      "fields": {
        "EccentricityInX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EccentricityInXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EccentricityInY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EccentricityInYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EccentricityInZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EccentricityInZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConnectionPointGeometry": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [
        "IfcConnectionGeometry"
      ],
      "fields": {
        "PointOnRelatingElement": {
          "type": "IfcPointOrVertexPoint",
          "reference": true,
          "many": false
        },
        "PointOnRelatedElement": {
          "type": "IfcPointOrVertexPoint",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcConnectionSurfaceGeometry": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [
        "IfcConnectionGeometry"
      ],
      "fields": {
        "SurfaceOnRelatingElement": {
          "type": "IfcSurfaceOrFaceSurface",
          "reference": true,
          "many": false
        },
        "SurfaceOnRelatedElement": {
          "type": "IfcSurfaceOrFaceSurface",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcConnectionVolumeGeometry": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [
        "IfcConnectionGeometry"
      ],
      "fields": {
        "VolumeOnRelatingElement": {
          "type": "IfcSolidOrShell",
          "reference": true,
          "many": false
        },
        "VolumeOnRelatedElement": {
          "type": "IfcSolidOrShell",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcConstraint": {
      "domain": "ifcconstraintresource",
      "superclasses": [
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ConstraintGrade": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ConstraintSource": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CreatingActor": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "CreationTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "UserDefinedGrade": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasExternalReferences": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        },
        "PropertiesForConstraint": {
          "type": "IfcResourceConstraintRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcConstructionEquipmentResource": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResource"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConstructionEquipmentResourceType": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResourceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConstructionMaterialResource": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResource"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConstructionMaterialResourceType": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResourceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConstructionProductResource": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResource"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConstructionProductResourceType": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResourceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConstructionResource": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcResource"
      ],
      "fields": {
        "Usage": {
          "type": "IfcResourceTime",
          "reference": true,
          "many": false
        },
        "BaseCosts": {
          "type": "IfcAppliedValue",
          "reference": true,
          "many": true
        },
        "BaseQuantity": {
          "type": "IfcPhysicalQuantity",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcConstructionResourceType": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcTypeResource"
      ],
      "fields": {
        "BaseCosts": {
          "type": "IfcAppliedValue",
          "reference": true,
          "many": true
        },
        "BaseQuantity": {
          "type": "IfcPhysicalQuantity",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcContext": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObjectDefinition"
      ],
      "fields": {
        "ObjectType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Phase": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RepresentationContexts": {
          "type": "IfcRepresentationContext",
          "reference": true,
          "many": true
        },
        "UnitsInContext": {
          "type": "IfcUnitAssignment",
          "reference": true,
          "many": false
        },
        "IsDefinedBy": {
          "type": "IfcRelDefinesByProperties",
          "reference": true,
          "many": true
        },
        "Declares": {
          "type": "IfcRelDeclares",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcContextDependentUnit": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcNamedUnit",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasExternalReference": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcControl": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObject"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Controls": {
          "type": "IfcRelAssignsToControl",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcController": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcControllerType": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcConversionBasedUnit": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcNamedUnit",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ConversionFactor": {
          "type": "IfcMeasureWithUnit",
          "reference": true,
          "many": false
        },
        "HasExternalReference": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcConversionBasedUnitWithOffset": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcConversionBasedUnit"
      ],
      "fields": {
        "ConversionOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ConversionOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCooledBeam": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCooledBeamType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCoolingTower": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCoolingTowerType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCoordinateOperation": {
      "domain": "ifcrepresentationresource",
      "superclasses": [],
      "fields": {
        "SourceCRS": {
          "type": "IfcCoordinateReferenceSystemSelect",
          "reference": true,
          "many": false
        },
        "TargetCRS": {
          "type": "IfcCoordinateReferenceSystem",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcCoordinateReferenceSystem": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcCoordinateReferenceSystemSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "GeodeticDatum": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "VerticalDatum": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCostItem": {
      "domain": "ifcsharedmgmtelements",
      "superclasses": [
        "IfcControl"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "CostValues": {
          "type": "IfcCostValue",
          "reference": true,
          "many": true
        },
        "CostQuantities": {
          "type": "IfcPhysicalQuantity",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcCostSchedule": {
      "domain": "ifcsharedmgmtelements",
      "superclasses": [
        "IfcControl"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Status": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SubmittedOn": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "UpdateDate": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCostValue": {
      "domain": "ifccostresource",
      "superclasses": [
        "IfcAppliedValue"
      ],
      "fields": {}
    },
    "IfcCovering": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "CoversSpaces": {
          "type": "IfcRelCoversSpaces",
          "reference": true,
          "many": true
        },
        "CoversElements": {
          "type": "IfcRelCoversBldgElements",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcCoveringType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCrewResource": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResource"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCrewResourceType": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResourceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCsgPrimitive3D": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcBooleanOperand",
        "IfcCsgSelect"
      ],
      "fields": {
        "Position": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCsgSolid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSolidModel"
      ],
      "fields": {
        "TreeRootExpression": {
          "type": "IfcCsgSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcCurrencyRelationship": {
      "domain": "ifccostresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "RelatingMonetaryUnit": {
          "type": "IfcMonetaryUnit",
          "reference": true,
          "many": false
        },
        "RelatedMonetaryUnit": {
          "type": "IfcMonetaryUnit",
          "reference": true,
          "many": false
        },
        "ExchangeRate": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ExchangeRateAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RateDateTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RateSource": {
          "type": "IfcLibraryInformation",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcCurtainWall": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCurtainWallType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcGeometricSetSelect"
      ],
      "fields": {
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCurveBoundedPlane": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundedSurface"
      ],
      "fields": {
        "BasisSurface": {
          "type": "IfcPlane",
          "reference": true,
          "many": false
        },
        "OuterBoundary": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "InnerBoundaries": {
          "type": "IfcCurve",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcCurveBoundedSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundedSurface"
      ],
      "fields": {
        "BasisSurface": {
          "type": "IfcSurface",
          "reference": true,
          "many": false
        },
        "Boundaries": {
          "type": "IfcBoundaryCurve",
          "reference": true,
          "many": true
        },
        "ImplicitOuter": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCurveStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationStyle",
        "IfcPresentationStyleSelect"
      ],
      "fields": {
        "CurveFont": {
          "type": "IfcCurveFontOrScaledCurveFontSelect",
          "reference": true,
          "many": false
        },
        "CurveWidth": {
          "type": "IfcSizeSelect",
          "reference": true,
          "many": false
        },
        "CurveColour": {
          "type": "IfcColour",
          "reference": true,
          "many": false
        },
        "ModelOrDraughting": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCurveStyleFont": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem",
        "IfcCurveStyleFontSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PatternList": {
          "type": "IfcCurveStyleFontPattern",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcCurveStyleFontAndScaling": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem",
        "IfcCurveFontOrScaledCurveFontSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CurveFont": {
          "type": "IfcCurveStyleFontSelect",
          "reference": true,
          "many": false
        },
        "CurveFontScaling": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CurveFontScalingAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCurveStyleFontPattern": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {
        "VisibleSegmentLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "VisibleSegmentLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "InvisibleSegmentLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "InvisibleSegmentLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCylindricalSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcElementarySurface"
      ],
      "fields": {
        "Radius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDamper": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowController"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDamperType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowControllerType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDerivedProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcProfileDef"
      ],
      "fields": {
        "ParentProfile": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        },
        "Operator": {
          "type": "IfcCartesianTransformationOperator2D",
          "reference": true,
          "many": false
        },
        "Label": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDerivedUnit": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcUnit"
      ],
      "fields": {
        "Elements": {
          "type": "IfcDerivedUnitElement",
          "reference": true,
          "many": true
        },
        "UnitType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDerivedUnitElement": {
      "domain": "ifcmeasureresource",
      "superclasses": [],
      "fields": {
        "Unit": {
          "type": "IfcNamedUnit",
          "reference": true,
          "many": false
        },
        "Exponent": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDimensionalExponents": {
      "domain": "ifcmeasureresource",
      "superclasses": [],
      "fields": {
        "LengthExponent": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "MassExponent": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "TimeExponent": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "ElectricCurrentExponent": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "ThermodynamicTemperatureExponent": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "AmountOfSubstanceExponent": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "LuminousIntensityExponent": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDirection": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcGridPlacementDirectionSelect",
        "IfcVectorOrDirection"
      ],
      "fields": {
        "DirectionRatios": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "DirectionRatiosAsString": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDiscreteAccessory": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementComponent"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDiscreteAccessoryType": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementComponentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDistributionChamberElement": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDistributionChamberElementType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDistributionCircuit": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionSystem"
      ],
      "fields": {}
    },
    "IfcDistributionControlElement": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionElement"
      ],
      "fields": {
        "AssignedToFlowElement": {
          "type": "IfcRelFlowControlElements",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcDistributionControlElementType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionElementType"
      ],
      "fields": {}
    },
    "IfcDistributionElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {
        "HasPorts": {
          "type": "IfcRelConnectsPortToElement",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcDistributionElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElementType"
      ],
      "fields": {}
    },
    "IfcDistributionFlowElement": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionElement"
      ],
      "fields": {
        "HasControlElements": {
          "type": "IfcRelFlowControlElements",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcDistributionFlowElementType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionElementType"
      ],
      "fields": {}
    },
    "IfcDistributionPort": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcPort"
      ],
      "fields": {
        "FlowDirection": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "SystemType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDistributionSystem": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcSystem"
      ],
      "fields": {
        "LongName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDocumentInformation": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcExternalInformation",
        "IfcDocumentSelect"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Location": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Purpose": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "IntendedUse": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Scope": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Revision": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DocumentOwner": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "Editors": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": true
        },
        "CreationTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LastRevisionTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ElectronicFormat": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ValidFrom": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ValidUntil": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Confidentiality": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Status": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "DocumentInfoForObjects": {
          "type": "IfcRelAssociatesDocument",
          "reference": true,
          "many": true
        },
        "HasDocumentReferences": {
          "type": "IfcDocumentReference",
          "reference": true,
          "many": true
        },
        "IsPointedTo": {
          "type": "IfcDocumentInformationRelationship",
          "reference": true,
          "many": true
        },
        "IsPointer": {
          "type": "IfcDocumentInformationRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcDocumentInformationRelationship": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "RelatingDocument": {
          "type": "IfcDocumentInformation",
          "reference": true,
          "many": false
        },
        "RelatedDocuments": {
          "type": "IfcDocumentInformation",
          "reference": true,
          "many": true
        },
        "RelationshipType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDocumentReference": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcExternalReference",
        "IfcDocumentSelect"
      ],
      "fields": {
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ReferencedDocument": {
          "type": "IfcDocumentInformation",
          "reference": true,
          "many": false
        },
        "DocumentRefForObjects": {
          "type": "IfcRelAssociatesDocument",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcDoor": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "OverallHeight": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OverallHeightAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OverallWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OverallWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "OperationType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedOperationType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDoorLiningProperties": {
      "domain": "ifcarchitecturedomain",
      "superclasses": [
        "IfcPreDefinedPropertySet"
      ],
      "fields": {
        "LiningDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LiningThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ThresholdDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ThresholdDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ThresholdThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ThresholdThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransomThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransomThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransomOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransomOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LiningOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ThresholdOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ThresholdOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CasingThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CasingThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CasingDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CasingDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ShapeAspectStyle": {
          "type": "IfcShapeAspect",
          "reference": true,
          "many": false
        },
        "LiningToPanelOffsetX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningToPanelOffsetXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LiningToPanelOffsetY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningToPanelOffsetYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDoorPanelProperties": {
      "domain": "ifcarchitecturedomain",
      "superclasses": [
        "IfcPreDefinedPropertySet"
      ],
      "fields": {
        "PanelDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PanelDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PanelOperation": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PanelWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PanelWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PanelPosition": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ShapeAspectStyle": {
          "type": "IfcShapeAspect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcDoorStandardCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcDoor"
      ],
      "fields": {}
    },
    "IfcDoorStyle": {
      "domain": "ifcarchitecturedomain",
      "superclasses": [
        "IfcTypeProduct"
      ],
      "fields": {
        "OperationType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ConstructionType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ParameterTakesPrecedence": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Sizeable": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDoorType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "OperationType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ParameterTakesPrecedence": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedOperationType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDraughtingPreDefinedColour": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPreDefinedColour"
      ],
      "fields": {}
    },
    "IfcDraughtingPreDefinedCurveFont": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPreDefinedCurveFont"
      ],
      "fields": {}
    },
    "IfcDuctFitting": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowFitting"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDuctFittingType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowFittingType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDuctSegment": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowSegment"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDuctSegmentType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowSegmentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDuctSilencer": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTreatmentDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDuctSilencerType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTreatmentDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEdge": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcTopologicalRepresentationItem"
      ],
      "fields": {
        "EdgeStart": {
          "type": "IfcVertex",
          "reference": true,
          "many": false
        },
        "EdgeEnd": {
          "type": "IfcVertex",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcEdgeCurve": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcEdge",
        "IfcCurveOrEdgeCurve"
      ],
      "fields": {
        "EdgeGeometry": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "SameSense": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEdgeLoop": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcLoop"
      ],
      "fields": {
        "EdgeList": {
          "type": "IfcOrientedEdge",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcElectricAppliance": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricApplianceType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricDistributionBoard": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowController"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricDistributionBoardType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowControllerType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricFlowStorageDevice": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowStorageDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricFlowStorageDeviceType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowStorageDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricGenerator": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricGeneratorType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricMotor": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricMotorType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricTimeControl": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowController"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricTimeControlType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowControllerType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcProduct",
        "IfcStructuralActivityAssignmentSelect"
      ],
      "fields": {
        "Tag": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FillsVoids": {
          "type": "IfcRelFillsElement",
          "reference": true,
          "many": true
        },
        "ConnectedTo": {
          "type": "IfcRelConnectsElements",
          "reference": true,
          "many": true
        },
        "IsInterferedByElements": {
          "type": "IfcRelInterferesElements",
          "reference": true,
          "many": true
        },
        "InterferesElements": {
          "type": "IfcRelInterferesElements",
          "reference": true,
          "many": true
        },
        "HasProjections": {
          "type": "IfcRelProjectsElement",
          "reference": true,
          "many": true
        },
        "ReferencedInStructures": {
          "type": "IfcRelReferencedInSpatialStructure",
          "reference": true,
          "many": true
        },
        "HasOpenings": {
          "type": "IfcRelVoidsElement",
          "reference": true,
          "many": true
        },
        "IsConnectionRealization": {
          "type": "IfcRelConnectsWithRealizingElements",
          "reference": true,
          "many": true
        },
        "ProvidesBoundaries": {
          "type": "IfcRelSpaceBoundary",
          "reference": true,
          "many": true
        },
        "ConnectedFrom": {
          "type": "IfcRelConnectsElements",
          "reference": true,
          "many": true
        },
        "ContainedInStructure": {
          "type": "IfcRelContainedInSpatialStructure",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcElementAssembly": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {
        "AssemblyPlace": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElementAssemblyType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElementComponent": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {}
    },
    "IfcElementComponentType": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementType"
      ],
      "fields": {}
    },
    "IfcElementQuantity": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcQuantitySet"
      ],
      "fields": {
        "MethodOfMeasurement": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Quantities": {
          "type": "IfcPhysicalQuantity",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcTypeProduct"
      ],
      "fields": {
        "ElementType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElementarySurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcSurface"
      ],
      "fields": {
        "Position": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcEllipse": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcConic"
      ],
      "fields": {
        "SemiAxis1": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SemiAxis1AsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SemiAxis2": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SemiAxis2AsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEllipseProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "SemiAxis1": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SemiAxis1AsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SemiAxis2": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SemiAxis2AsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEnergyConversionDevice": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {}
    },
    "IfcEnergyConversionDeviceType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {}
    },
    "IfcEngine": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEngineType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEvaporativeCooler": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEvaporativeCoolerType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEvaporator": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEvaporatorType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEvent": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcProcess"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "EventTriggerType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedEventTriggerType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EventOccurenceTime": {
          "type": "IfcEventTime",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcEventTime": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSchedulingTime"
      ],
      "fields": {
        "ActualDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EarlyDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LateDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ScheduleDate": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEventType": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcTypeProcess"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "EventTriggerType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedEventTriggerType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcExtendedProperties": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcPropertyAbstraction"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Properties": {
          "type": "IfcProperty",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcExternalInformation": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcResourceObjectSelect"
      ],
      "fields": {}
    },
    "IfcExternalReference": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcLightDistributionDataSourceSelect",
        "IfcObjectReferenceSelect",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Location": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ExternalReferenceForResources": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcExternalReferenceRelationship": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "RelatingReference": {
          "type": "IfcExternalReference",
          "reference": true,
          "many": false
        },
        "RelatedResourceObjects": {
          "type": "IfcResourceObjectSelect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcExternalSpatialElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcExternalSpatialStructureElement",
        "IfcSpaceBoundarySelect"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "BoundedBy": {
          "type": "IfcRelSpaceBoundary",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcExternalSpatialStructureElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialElement"
      ],
      "fields": {}
    },
    "IfcExternallyDefinedHatchStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcExternalReference",
        "IfcFillStyleSelect"
      ],
      "fields": {}
    },
    "IfcExternallyDefinedSurfaceStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcExternalReference",
        "IfcSurfaceStyleElementSelect"
      ],
      "fields": {}
    },
    "IfcExternallyDefinedTextFont": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcExternalReference",
        "IfcTextFontSelect"
      ],
      "fields": {}
    },
    "IfcExtrudedAreaSolid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSweptAreaSolid"
      ],
      "fields": {
        "ExtrudedDirection": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        },
        "Depth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcExtrudedAreaSolidTapered": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcExtrudedAreaSolid"
      ],
      "fields": {
        "EndSweptArea": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcFace": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcTopologicalRepresentationItem"
      ],
      "fields": {
        "Bounds": {
          "type": "IfcFaceBound",
          "reference": true,
          "many": true
        },
        "HasTextureMaps": {
          "type": "IfcTextureMap",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcFaceBasedSurfaceModel": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcSurfaceOrFaceSurface"
      ],
      "fields": {
        "FbsmFaces": {
          "type": "IfcConnectedFaceSet",
          "reference": true,
          "many": true
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFaceBound": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcTopologicalRepresentationItem"
      ],
      "fields": {
        "Bound": {
          "type": "IfcLoop",
          "reference": true,
          "many": false
        },
        "Orientation": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFaceOuterBound": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcFaceBound"
      ],
      "fields": {}
    },
    "IfcFaceSurface": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcFace",
        "IfcSurfaceOrFaceSurface"
      ],
      "fields": {
        "FaceSurface": {
          "type": "IfcSurface",
          "reference": true,
          "many": false
        },
        "SameSense": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFacetedBrep": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcManifoldSolidBrep"
      ],
      "fields": {}
    },
    "IfcFacetedBrepWithVoids": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcFacetedBrep"
      ],
      "fields": {
        "Voids": {
          "type": "IfcClosedShell",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcFailureConnectionCondition": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralConnectionCondition"
      ],
      "fields": {
        "TensionFailureX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TensionFailureXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TensionFailureY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TensionFailureYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TensionFailureZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TensionFailureZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CompressionFailureX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CompressionFailureXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CompressionFailureY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CompressionFailureYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CompressionFailureZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CompressionFailureZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFan": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowMovingDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFanType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowMovingDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFastener": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementComponent"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFastenerType": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementComponentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFeatureElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {}
    },
    "IfcFeatureElementAddition": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcFeatureElement"
      ],
      "fields": {
        "ProjectsElements": {
          "type": "IfcRelProjectsElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcFeatureElementSubtraction": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcFeatureElement"
      ],
      "fields": {
        "VoidsElements": {
          "type": "IfcRelVoidsElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcFillAreaStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationStyle",
        "IfcPresentationStyleSelect"
      ],
      "fields": {
        "FillStyles": {
          "type": "IfcFillStyleSelect",
          "reference": true,
          "many": true
        },
        "ModelorDraughting": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFillAreaStyleHatching": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcFillStyleSelect"
      ],
      "fields": {
        "HatchLineAppearance": {
          "type": "IfcCurveStyle",
          "reference": true,
          "many": false
        },
        "StartOfNextHatchLine": {
          "type": "IfcHatchLineDistanceSelect",
          "reference": true,
          "many": false
        },
        "PointOfReferenceHatchLine": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": false
        },
        "PatternStart": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": false
        },
        "HatchLineAngle": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "HatchLineAngleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFillAreaStyleTiles": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcFillStyleSelect"
      ],
      "fields": {
        "TilingPattern": {
          "type": "IfcVector",
          "reference": true,
          "many": true
        },
        "Tiles": {
          "type": "IfcStyledItem",
          "reference": true,
          "many": true
        },
        "TilingScale": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TilingScaleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFilter": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTreatmentDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFilterType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTreatmentDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFireSuppressionTerminal": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFireSuppressionTerminalType": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFixedReferenceSweptAreaSolid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSweptAreaSolid"
      ],
      "fields": {
        "Directrix": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "StartParam": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "StartParamAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EndParam": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EndParamAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FixedReference": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcFlowController": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {}
    },
    "IfcFlowControllerType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {}
    },
    "IfcFlowFitting": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {}
    },
    "IfcFlowFittingType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {}
    },
    "IfcFlowInstrument": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFlowInstrumentType": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFlowMeter": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowController"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFlowMeterType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowControllerType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFlowMovingDevice": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {}
    },
    "IfcFlowMovingDeviceType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {}
    },
    "IfcFlowSegment": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {}
    },
    "IfcFlowSegmentType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {}
    },
    "IfcFlowStorageDevice": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {}
    },
    "IfcFlowStorageDeviceType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {}
    },
    "IfcFlowTerminal": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {}
    },
    "IfcFlowTerminalType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {}
    },
    "IfcFlowTreatmentDevice": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElement"
      ],
      "fields": {}
    },
    "IfcFlowTreatmentDeviceType": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcDistributionFlowElementType"
      ],
      "fields": {}
    },
    "IfcFooting": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFootingType": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFurnishingElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {}
    },
    "IfcFurnishingElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElementType"
      ],
      "fields": {}
    },
    "IfcFurniture": {
      "domain": "ifcsharedfacilitieselements",
      "superclasses": [
        "IfcFurnishingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFurnitureType": {
      "domain": "ifcsharedfacilitieselements",
      "superclasses": [
        "IfcFurnishingElementType"
      ],
      "fields": {
        "AssemblyPlace": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcGeographicElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcGeographicElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcGeometricCurveSet": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricSet"
      ],
      "fields": {}
    },
    "IfcGeometricRepresentationContext": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcRepresentationContext",
        "IfcCoordinateReferenceSystemSelect"
      ],
      "fields": {
        "CoordinateSpaceDimension": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "Precision": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PrecisionAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WorldCoordinateSystem": {
          "type": "IfcAxis2Placement",
          "reference": true,
          "many": false
        },
        "TrueNorth": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        },
        "HasSubContexts": {
          "type": "IfcGeometricRepresentationSubContext",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcGeometricRepresentationItem": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcRepresentationItem"
      ],
      "fields": {}
    },
    "IfcGeometricRepresentationSubContext": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcGeometricRepresentationContext"
      ],
      "fields": {
        "ParentContext": {
          "type": "IfcGeometricRepresentationContext",
          "reference": true,
          "many": false
        },
        "TargetScale": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TargetScaleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TargetView": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedTargetView": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcGeometricSet": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "Elements": {
          "type": "IfcGeometricSetSelect",
          "reference": true,
          "many": true
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcGrid": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcProduct"
      ],
      "fields": {
        "UAxes": {
          "type": "IfcGridAxis",
          "reference": true,
          "many": true
        },
        "VAxes": {
          "type": "IfcGridAxis",
          "reference": true,
          "many": true
        },
        "WAxes": {
          "type": "IfcGridAxis",
          "reference": true,
          "many": true
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ContainedInStructure": {
          "type": "IfcRelContainedInSpatialStructure",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcGridAxis": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [],
      "fields": {
        "AxisTag": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "AxisCurve": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "SameSense": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PartOfW": {
          "type": "IfcGrid",
          "reference": true,
          "many": true
        },
        "PartOfV": {
          "type": "IfcGrid",
          "reference": true,
          "many": true
        },
        "PartOfU": {
          "type": "IfcGrid",
          "reference": true,
          "many": true
        },
        "HasIntersections": {
          "type": "IfcVirtualGridIntersection",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcGridPlacement": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [
        "IfcObjectPlacement"
      ],
      "fields": {
        "PlacementLocation": {
          "type": "IfcVirtualGridIntersection",
          "reference": true,
          "many": false
        },
        "PlacementRefDirection": {
          "type": "IfcGridPlacementDirectionSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcGroup": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObject"
      ],
      "fields": {
        "IsGroupedBy": {
          "type": "IfcRelAssignsToGroup",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcHalfSpaceSolid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcBooleanOperand"
      ],
      "fields": {
        "BaseSurface": {
          "type": "IfcSurface",
          "reference": true,
          "many": false
        },
        "AgreementFlag": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcHeatExchanger": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcHeatExchangerType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcHumidifier": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcHumidifierType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcIShapeProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "OverallWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OverallWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OverallDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OverallDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WebThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WebThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeEdgeRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeEdgeRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeSlope": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeSlopeAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcImageTexture": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcSurfaceTexture"
      ],
      "fields": {
        "URLReference": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcIndexedColourMap": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {
        "MappedTo": {
          "type": "IfcTessellatedFaceSet",
          "reference": true,
          "many": false
        },
        "Overrides": {
          "type": "IfcSurfaceStyleShading",
          "reference": true,
          "many": false
        },
        "Colours": {
          "type": "IfcColourRgbList",
          "reference": true,
          "many": false
        },
        "ColourIndex": {
          "type": "int",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcIndexedTextureMap": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcTextureCoordinate"
      ],
      "fields": {
        "MappedTo": {
          "type": "IfcTessellatedFaceSet",
          "reference": true,
          "many": false
        },
        "TexCoords": {
          "type": "IfcTextureVertexList",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcIndexedTriangleTextureMap": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcIndexedTextureMap"
      ],
      "fields": {}
    },
    "IfcInterceptor": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTreatmentDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcInterceptorType": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTreatmentDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcInventory": {
      "domain": "ifcsharedfacilitieselements",
      "superclasses": [
        "IfcGroup"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Jurisdiction": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "ResponsiblePersons": {
          "type": "IfcPerson",
          "reference": true,
          "many": true
        },
        "LastUpdateDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CurrentValue": {
          "type": "IfcCostValue",
          "reference": true,
          "many": false
        },
        "OriginalValue": {
          "type": "IfcCostValue",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcIrregularTimeSeries": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcTimeSeries"
      ],
      "fields": {
        "Values": {
          "type": "IfcIrregularTimeSeriesValue",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcIrregularTimeSeriesValue": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {
        "TimeStamp": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ListValues": {
          "type": "IfcValue",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcJunctionBox": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowFitting"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcJunctionBoxType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowFittingType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLShapeProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "Depth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Width": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Thickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EdgeRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EdgeRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LegSlope": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LegSlopeAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLaborResource": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResource"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLaborResourceType": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResourceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLagTime": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSchedulingTime"
      ],
      "fields": {
        "LagValue": {
          "type": "IfcTimeOrRatioSelect",
          "reference": true,
          "many": false
        },
        "DurationType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLamp": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLampType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLibraryInformation": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcExternalInformation",
        "IfcLibrarySelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Version": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Publisher": {
          "type": "IfcActorSelect",
          "reference": true,
          "many": false
        },
        "VersionDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Location": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LibraryInfoForObjects": {
          "type": "IfcRelAssociatesLibrary",
          "reference": true,
          "many": true
        },
        "HasLibraryReferences": {
          "type": "IfcLibraryReference",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcLibraryReference": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcExternalReference",
        "IfcLibrarySelect"
      ],
      "fields": {
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Language": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ReferencedLibrary": {
          "type": "IfcLibraryInformation",
          "reference": true,
          "many": false
        },
        "LibraryRefForObjects": {
          "type": "IfcRelAssociatesLibrary",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcLightDistributionData": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [],
      "fields": {
        "MainPlaneAngle": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MainPlaneAngleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SecondaryPlaneAngle": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "SecondaryPlaneAngleAsString": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "LuminousIntensity": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "LuminousIntensityAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcLightFixture": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLightFixtureType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLightIntensityDistribution": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [
        "IfcLightDistributionDataSourceSelect"
      ],
      "fields": {
        "LightDistributionCurve": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "DistributionData": {
          "type": "IfcLightDistributionData",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcLightSource": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LightColour": {
          "type": "IfcColourRgb",
          "reference": true,
          "many": false
        },
        "AmbientIntensity": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "AmbientIntensityAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Intensity": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "IntensityAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLightSourceAmbient": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [
        "IfcLightSource"
      ],
      "fields": {}
    },
    "IfcLightSourceDirectional": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [
        "IfcLightSource"
      ],
      "fields": {
        "Orientation": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcLightSourceGoniometric": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [
        "IfcLightSource"
      ],
      "fields": {
        "Position": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        },
        "ColourAppearance": {
          "type": "IfcColourRgb",
          "reference": true,
          "many": false
        },
        "ColourTemperature": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ColourTemperatureAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LuminousFlux": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LuminousFluxAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LightEmissionSource": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "LightDistributionDataSource": {
          "type": "IfcLightDistributionDataSourceSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcLightSourcePositional": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [
        "IfcLightSource"
      ],
      "fields": {
        "Position": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": false
        },
        "Radius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ConstantAttenuation": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ConstantAttenuationAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DistanceAttenuation": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DistanceAttenuationAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "QuadricAttenuation": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "QuadricAttenuationAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLightSourceSpot": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [
        "IfcLightSourcePositional"
      ],
      "fields": {
        "Orientation": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        },
        "ConcentrationExponent": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ConcentrationExponentAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SpreadAngle": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SpreadAngleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BeamWidthAngle": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BeamWidthAngleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLine": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCurve"
      ],
      "fields": {
        "Pnt": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": false
        },
        "Dir": {
          "type": "IfcVector",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcLocalPlacement": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [
        "IfcObjectPlacement"
      ],
      "fields": {
        "PlacementRelTo": {
          "type": "IfcObjectPlacement",
          "reference": true,
          "many": false
        },
        "RelativePlacement": {
          "type": "IfcAxis2Placement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcLoop": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcTopologicalRepresentationItem"
      ],
      "fields": {}
    },
    "IfcManifoldSolidBrep": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSolidModel"
      ],
      "fields": {
        "Outer": {
          "type": "IfcClosedShell",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMapConversion": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcCoordinateOperation"
      ],
      "fields": {
        "Eastings": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EastingsAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Northings": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NorthingsAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OrthogonalHeight": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OrthogonalHeightAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "XAxisAbscissa": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "XAxisAbscissaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "XAxisOrdinate": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "XAxisOrdinateAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Scale": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ScaleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMappedItem": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcRepresentationItem"
      ],
      "fields": {
        "MappingSource": {
          "type": "IfcRepresentationMap",
          "reference": true,
          "many": false
        },
        "MappingTarget": {
          "type": "IfcCartesianTransformationOperator",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMaterial": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialDefinition"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Category": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasRepresentation": {
          "type": "IfcMaterialDefinitionRepresentation",
          "reference": true,
          "many": true
        },
        "IsRelatedWith": {
          "type": "IfcMaterialRelationship",
          "reference": true,
          "many": true
        },
        "RelatesTo": {
          "type": "IfcMaterialRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcMaterialClassificationRelationship": {
      "domain": "ifcmaterialresource",
      "superclasses": [],
      "fields": {
        "MaterialClassifications": {
          "type": "IfcClassificationSelect",
          "reference": true,
          "many": true
        },
        "ClassifiedMaterial": {
          "type": "IfcMaterial",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMaterialConstituent": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialDefinition"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Material": {
          "type": "IfcMaterial",
          "reference": true,
          "many": false
        },
        "Fraction": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FractionAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Category": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ToMaterialConstituentSet": {
          "type": "IfcMaterialConstituentSet",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMaterialConstituentSet": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialDefinition"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MaterialConstituents": {
          "type": "IfcMaterialConstituent",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcMaterialDefinition": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialSelect",
        "IfcObjectReferenceSelect",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "AssociatedTo": {
          "type": "IfcRelAssociatesMaterial",
          "reference": true,
          "many": true
        },
        "HasExternalReferences": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        },
        "HasProperties": {
          "type": "IfcMaterialProperties",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcMaterialDefinitionRepresentation": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcProductRepresentation"
      ],
      "fields": {
        "RepresentedMaterial": {
          "type": "IfcMaterial",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMaterialLayer": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialDefinition"
      ],
      "fields": {
        "Material": {
          "type": "IfcMaterial",
          "reference": true,
          "many": false
        },
        "LayerThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LayerThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "IsVentilated": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Category": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Priority": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PriorityAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ToMaterialLayerSet": {
          "type": "IfcMaterialLayerSet",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMaterialLayerSet": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialDefinition"
      ],
      "fields": {
        "MaterialLayers": {
          "type": "IfcMaterialLayer",
          "reference": true,
          "many": true
        },
        "LayerSetName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TotalThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TotalThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMaterialLayerSetUsage": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialUsageDefinition"
      ],
      "fields": {
        "ForLayerSet": {
          "type": "IfcMaterialLayerSet",
          "reference": true,
          "many": false
        },
        "LayerSetDirection": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "DirectionSense": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "OffsetFromReferenceLine": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OffsetFromReferenceLineAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ReferenceExtent": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ReferenceExtentAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMaterialLayerWithOffsets": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialLayer"
      ],
      "fields": {
        "OffsetDirection": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "OffsetValues": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "OffsetValuesAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcMaterialList": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialSelect"
      ],
      "fields": {
        "Materials": {
          "type": "IfcMaterial",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcMaterialProfile": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialDefinition"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Material": {
          "type": "IfcMaterial",
          "reference": true,
          "many": false
        },
        "Profile": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        },
        "Priority": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PriorityAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Category": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ToMaterialProfileSet": {
          "type": "IfcMaterialProfileSet",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMaterialProfileSet": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialDefinition"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MaterialProfiles": {
          "type": "IfcMaterialProfile",
          "reference": true,
          "many": true
        },
        "CompositeProfile": {
          "type": "IfcCompositeProfileDef",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMaterialProfileSetUsage": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialUsageDefinition"
      ],
      "fields": {
        "ForProfileSet": {
          "type": "IfcMaterialProfileSet",
          "reference": true,
          "many": false
        },
        "CardinalPoint": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "ReferenceExtent": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ReferenceExtentAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMaterialProfileSetUsageTapering": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialProfileSetUsage"
      ],
      "fields": {
        "ForProfileEndSet": {
          "type": "IfcMaterialProfileSet",
          "reference": true,
          "many": false
        },
        "CardinalEndPoint": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMaterialProfileWithOffsets": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialProfile"
      ],
      "fields": {
        "OffsetValues": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "OffsetValuesAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcMaterialProperties": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcExtendedProperties"
      ],
      "fields": {
        "Material": {
          "type": "IfcMaterialDefinition",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMaterialRelationship": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "RelatingMaterial": {
          "type": "IfcMaterial",
          "reference": true,
          "many": false
        },
        "RelatedMaterials": {
          "type": "IfcMaterial",
          "reference": true,
          "many": true
        },
        "Expression": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMaterialUsageDefinition": {
      "domain": "ifcmaterialresource",
      "superclasses": [
        "IfcMaterialSelect"
      ],
      "fields": {
        "AssociatedTo": {
          "type": "IfcRelAssociatesMaterial",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcMeasureWithUnit": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcAppliedValueSelect",
        "IfcMetricValueSelect"
      ],
      "fields": {
        "ValueComponent": {
          "type": "IfcValue",
          "reference": true,
          "many": false
        },
        "UnitComponent": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMechanicalFastener": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementComponent"
      ],
      "fields": {
        "NominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "NominalLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMechanicalFastenerType": {
      "domain": "ifcsharedcomponentelements",
      "superclasses": [
        "IfcElementComponentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "NominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "NominalLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMedicalDevice": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMedicalDeviceType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMember": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMemberStandardCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcMember"
      ],
      "fields": {}
    },
    "IfcMemberType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMetric": {
      "domain": "ifcconstraintresource",
      "superclasses": [
        "IfcConstraint"
      ],
      "fields": {
        "Benchmark": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ValueSource": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DataValue": {
          "type": "IfcMetricValueSelect",
          "reference": true,
          "many": false
        },
        "ReferencePath": {
          "type": "IfcReference",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcMirroredProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcDerivedProfileDef"
      ],
      "fields": {}
    },
    "IfcMonetaryUnit": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcUnit"
      ],
      "fields": {
        "Currency": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMotorConnection": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMotorConnectionType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcNamedUnit": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcUnit"
      ],
      "fields": {
        "Dimensions": {
          "type": "IfcDimensionalExponents",
          "reference": true,
          "many": false
        },
        "UnitType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcObject": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObjectDefinition"
      ],
      "fields": {
        "ObjectType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "IsDeclaredBy": {
          "type": "IfcRelDefinesByObject",
          "reference": true,
          "many": true
        },
        "Declares": {
          "type": "IfcRelDefinesByObject",
          "reference": true,
          "many": true
        },
        "IsTypedBy": {
          "type": "IfcRelDefinesByType",
          "reference": true,
          "many": true
        },
        "IsDefinedBy": {
          "type": "IfcRelDefinesByProperties",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcObjectDefinition": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRoot",
        "IfcDefinitionSelect"
      ],
      "fields": {
        "HasAssignments": {
          "type": "IfcRelAssigns",
          "reference": true,
          "many": true
        },
        "Nests": {
          "type": "IfcRelNests",
          "reference": true,
          "many": true
        },
        "IsNestedBy": {
          "type": "IfcRelNests",
          "reference": true,
          "many": true
        },
        "HasContext": {
          "type": "IfcRelDeclares",
          "reference": true,
          "many": true
        },
        "IsDecomposedBy": {
          "type": "IfcRelAggregates",
          "reference": true,
          "many": true
        },
        "Decomposes": {
          "type": "IfcRelAggregates",
          "reference": true,
          "many": true
        },
        "HasAssociations": {
          "type": "IfcRelAssociates",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcObjectPlacement": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [],
      "fields": {
        "PlacesObject": {
          "type": "IfcProduct",
          "reference": true,
          "many": true
        },
        "ReferencedByPlacements": {
          "type": "IfcLocalPlacement",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcObjective": {
      "domain": "ifcconstraintresource",
      "superclasses": [
        "IfcConstraint"
      ],
      "fields": {
        "BenchmarkValues": {
          "type": "IfcConstraint",
          "reference": true,
          "many": true
        },
        "LogicalAggregator": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ObjectiveQualifier": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedQualifier": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcOccupant": {
      "domain": "ifcsharedfacilitieselements",
      "superclasses": [
        "IfcActor"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcOffsetCurve2D": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCurve"
      ],
      "fields": {
        "BasisCurve": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "Distance": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DistanceAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SelfIntersect": {
          "type": "boolean",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcOffsetCurve3D": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCurve"
      ],
      "fields": {
        "BasisCurve": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "Distance": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DistanceAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SelfIntersect": {
          "type": "boolean",
          "reference": false,
          "many": false
        },
        "RefDirection": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcOpenShell": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcConnectedFaceSet",
        "IfcShell"
      ],
      "fields": {}
    },
    "IfcOpeningElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcFeatureElementSubtraction"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "HasFillings": {
          "type": "IfcRelFillsElement",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcOpeningStandardCase": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcOpeningElement"
      ],
      "fields": {}
    },
    "IfcOrganization": {
      "domain": "ifcactorresource",
      "superclasses": [
        "IfcActorSelect",
        "IfcObjectReferenceSelect",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Roles": {
          "type": "IfcActorRole",
          "reference": true,
          "many": true
        },
        "Addresses": {
          "type": "IfcAddress",
          "reference": true,
          "many": true
        },
        "IsRelatedBy": {
          "type": "IfcOrganizationRelationship",
          "reference": true,
          "many": true
        },
        "Relates": {
          "type": "IfcOrganizationRelationship",
          "reference": true,
          "many": true
        },
        "Engages": {
          "type": "IfcPersonAndOrganization",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcOrganizationRelationship": {
      "domain": "ifcactorresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "RelatingOrganization": {
          "type": "IfcOrganization",
          "reference": true,
          "many": false
        },
        "RelatedOrganizations": {
          "type": "IfcOrganization",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcOrientedEdge": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcEdge"
      ],
      "fields": {
        "EdgeElement": {
          "type": "IfcEdge",
          "reference": true,
          "many": false
        },
        "Orientation": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcOuterBoundaryCurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundaryCurve"
      ],
      "fields": {}
    },
    "IfcOutlet": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcOutletType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcOwnerHistory": {
      "domain": "ifcutilityresource",
      "superclasses": [],
      "fields": {
        "OwningUser": {
          "type": "IfcPersonAndOrganization",
          "reference": true,
          "many": false
        },
        "OwningApplication": {
          "type": "IfcApplication",
          "reference": true,
          "many": false
        },
        "State": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ChangeAction": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "LastModifiedDate": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "LastModifyingUser": {
          "type": "IfcPersonAndOrganization",
          "reference": true,
          "many": false
        },
        "LastModifyingApplication": {
          "type": "IfcApplication",
          "reference": true,
          "many": false
        },
        "CreationDate": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcParameterizedProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcProfileDef"
      ],
      "fields": {
        "Position": {
          "type": "IfcAxis2Placement2D",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPath": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcTopologicalRepresentationItem"
      ],
      "fields": {
        "EdgeList": {
          "type": "IfcOrientedEdge",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPcurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCurve",
        "IfcCurveOnSurface"
      ],
      "fields": {
        "BasisSurface": {
          "type": "IfcSurface",
          "reference": true,
          "many": false
        },
        "ReferenceCurve": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPerformanceHistory": {
      "domain": "ifccontrolextension",
      "superclasses": [
        "IfcControl"
      ],
      "fields": {
        "LifeCyclePhase": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPermeableCoveringProperties": {
      "domain": "ifcarchitecturedomain",
      "superclasses": [
        "IfcPreDefinedPropertySet"
      ],
      "fields": {
        "OperationType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PanelPosition": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "FrameDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FrameDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FrameThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FrameThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ShapeAspectStyle": {
          "type": "IfcShapeAspect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPermit": {
      "domain": "ifcsharedmgmtelements",
      "superclasses": [
        "IfcControl"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Status": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongDescription": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPerson": {
      "domain": "ifcactorresource",
      "superclasses": [
        "IfcActorSelect",
        "IfcObjectReferenceSelect",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FamilyName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "GivenName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MiddleNames": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "PrefixTitles": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "SuffixTitles": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "Roles": {
          "type": "IfcActorRole",
          "reference": true,
          "many": true
        },
        "Addresses": {
          "type": "IfcAddress",
          "reference": true,
          "many": true
        },
        "EngagedIn": {
          "type": "IfcPersonAndOrganization",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPersonAndOrganization": {
      "domain": "ifcactorresource",
      "superclasses": [
        "IfcActorSelect",
        "IfcObjectReferenceSelect",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "ThePerson": {
          "type": "IfcPerson",
          "reference": true,
          "many": false
        },
        "TheOrganization": {
          "type": "IfcOrganization",
          "reference": true,
          "many": false
        },
        "Roles": {
          "type": "IfcActorRole",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPhysicalComplexQuantity": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcPhysicalQuantity"
      ],
      "fields": {
        "HasQuantities": {
          "type": "IfcPhysicalQuantity",
          "reference": true,
          "many": true
        },
        "Discrimination": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Quality": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Usage": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPhysicalQuantity": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasExternalReferences": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        },
        "PartOfComplex": {
          "type": "IfcPhysicalComplexQuantity",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPhysicalSimpleQuantity": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcPhysicalQuantity"
      ],
      "fields": {
        "Unit": {
          "type": "IfcNamedUnit",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPile": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ConstructionType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPileType": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPipeFitting": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowFitting"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPipeFittingType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowFittingType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPipeSegment": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowSegment"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPipeSegmentType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowSegmentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPixelTexture": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcSurfaceTexture"
      ],
      "fields": {
        "Width": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "Height": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "ColourComponents": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPlacement": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "Location": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPlanarBox": {
      "domain": "ifcpresentationdefinitionresource",
      "superclasses": [
        "IfcPlanarExtent"
      ],
      "fields": {
        "Placement": {
          "type": "IfcAxis2Placement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPlanarExtent": {
      "domain": "ifcpresentationdefinitionresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "SizeInX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SizeInXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SizeInY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SizeInYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPlane": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcElementarySurface"
      ],
      "fields": {}
    },
    "IfcPlate": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPlateStandardCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcPlate"
      ],
      "fields": {}
    },
    "IfcPlateType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPoint": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcGeometricSetSelect",
        "IfcPointOrVertexPoint"
      ],
      "fields": {}
    },
    "IfcPointOnCurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcPoint"
      ],
      "fields": {
        "BasisCurve": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "PointParameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PointParameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPointOnSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcPoint"
      ],
      "fields": {
        "BasisSurface": {
          "type": "IfcSurface",
          "reference": true,
          "many": false
        },
        "PointParameterU": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PointParameterUAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PointParameterV": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PointParameterVAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPolyLoop": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcLoop"
      ],
      "fields": {
        "Polygon": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPolygonalBoundedHalfSpace": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcHalfSpaceSolid"
      ],
      "fields": {
        "Position": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        },
        "PolygonalBoundary": {
          "type": "IfcBoundedCurve",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPolyline": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundedCurve"
      ],
      "fields": {
        "Points": {
          "type": "IfcCartesianPoint",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPort": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcProduct"
      ],
      "fields": {
        "ContainedIn": {
          "type": "IfcRelConnectsPortToElement",
          "reference": true,
          "many": true
        },
        "ConnectedFrom": {
          "type": "IfcRelConnectsPorts",
          "reference": true,
          "many": true
        },
        "ConnectedTo": {
          "type": "IfcRelConnectsPorts",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPostalAddress": {
      "domain": "ifcactorresource",
      "superclasses": [
        "IfcAddress"
      ],
      "fields": {
        "InternalLocation": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "AddressLines": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "PostalBox": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Town": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Region": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PostalCode": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Country": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPreDefinedColour": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPreDefinedItem",
        "IfcColour"
      ],
      "fields": {}
    },
    "IfcPreDefinedCurveFont": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPreDefinedItem",
        "IfcCurveStyleFontSelect"
      ],
      "fields": {}
    },
    "IfcPreDefinedItem": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPreDefinedProperties": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcPropertyAbstraction"
      ],
      "fields": {}
    },
    "IfcPreDefinedPropertySet": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertySetDefinition"
      ],
      "fields": {}
    },
    "IfcPreDefinedTextFont": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPreDefinedItem",
        "IfcTextFontSelect"
      ],
      "fields": {}
    },
    "IfcPresentationItem": {
      "domain": "ifcpresentationdefinitionresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcPresentationLayerAssignment": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "AssignedItems": {
          "type": "IfcLayeredItem",
          "reference": true,
          "many": true
        },
        "Identifier": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPresentationLayerWithStyle": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [
        "IfcPresentationLayerAssignment"
      ],
      "fields": {
        "LayerOn": {
          "type": "boolean",
          "reference": false,
          "many": false
        },
        "LayerFrozen": {
          "type": "boolean",
          "reference": false,
          "many": false
        },
        "LayerBlocked": {
          "type": "boolean",
          "reference": false,
          "many": false
        },
        "LayerStyles": {
          "type": "IfcPresentationStyle",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPresentationStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcStyleAssignmentSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPresentationStyleAssignment": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcStyleAssignmentSelect"
      ],
      "fields": {
        "Styles": {
          "type": "IfcPresentationStyleSelect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcProcedure": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcProcess"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcProcedureType": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcTypeProcess"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcProcess": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObject",
        "IfcProcessSelect"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongDescription": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "IsPredecessorTo": {
          "type": "IfcRelSequence",
          "reference": true,
          "many": true
        },
        "IsSuccessorFrom": {
          "type": "IfcRelSequence",
          "reference": true,
          "many": true
        },
        "OperatesOn": {
          "type": "IfcRelAssignsToProcess",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcProduct": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObject",
        "IfcProductSelect"
      ],
      "fields": {
        "ObjectPlacement": {
          "type": "IfcObjectPlacement",
          "reference": true,
          "many": false
        },
        "Representation": {
          "type": "IfcProductRepresentation",
          "reference": true,
          "many": false
        },
        "ReferencedBy": {
          "type": "IfcRelAssignsToProduct",
          "reference": true,
          "many": true
        },
        "geometry": {
          "type": "GeometryInfo",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcProductDefinitionShape": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcProductRepresentation",
        "IfcProductRepresentationSelect"
      ],
      "fields": {
        "ShapeOfProduct": {
          "type": "IfcProduct",
          "reference": true,
          "many": true
        },
        "HasShapeAspects": {
          "type": "IfcShapeAspect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcProductRepresentation": {
      "domain": "ifcrepresentationresource",
      "superclasses": [],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Representations": {
          "type": "IfcRepresentation",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "ProfileType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ProfileName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasExternalReference": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        },
        "HasProperties": {
          "type": "IfcProfileProperties",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcProfileProperties": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcExtendedProperties"
      ],
      "fields": {
        "ProfileDefinition": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcProject": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcContext"
      ],
      "fields": {}
    },
    "IfcProjectLibrary": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcContext"
      ],
      "fields": {}
    },
    "IfcProjectOrder": {
      "domain": "ifcsharedmgmtelements",
      "superclasses": [
        "IfcControl"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Status": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongDescription": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcProjectedCRS": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcCoordinateReferenceSystem"
      ],
      "fields": {
        "MapProjection": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MapZone": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MapUnit": {
          "type": "IfcNamedUnit",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcProjectionElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcFeatureElementAddition"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcProperty": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcPropertyAbstraction"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PartOfPset": {
          "type": "IfcPropertySet",
          "reference": true,
          "many": true
        },
        "PropertyForDependance": {
          "type": "IfcPropertyDependencyRelationship",
          "reference": true,
          "many": true
        },
        "PropertyDependsOn": {
          "type": "IfcPropertyDependencyRelationship",
          "reference": true,
          "many": true
        },
        "PartOfComplex": {
          "type": "IfcComplexProperty",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPropertyAbstraction": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "HasExternalReferences": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPropertyBoundedValue": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcSimpleProperty"
      ],
      "fields": {
        "UpperBoundValue": {
          "type": "IfcValue",
          "reference": true,
          "many": false
        },
        "LowerBoundValue": {
          "type": "IfcValue",
          "reference": true,
          "many": false
        },
        "Unit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        },
        "SetPointValue": {
          "type": "IfcValue",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPropertyDefinition": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRoot",
        "IfcDefinitionSelect"
      ],
      "fields": {
        "HasContext": {
          "type": "IfcRelDeclares",
          "reference": true,
          "many": true
        },
        "HasAssociations": {
          "type": "IfcRelAssociates",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPropertyDependencyRelationship": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "DependingProperty": {
          "type": "IfcProperty",
          "reference": true,
          "many": false
        },
        "DependantProperty": {
          "type": "IfcProperty",
          "reference": true,
          "many": false
        },
        "Expression": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPropertyEnumeratedValue": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcSimpleProperty"
      ],
      "fields": {
        "EnumerationValues": {
          "type": "IfcValue",
          "reference": true,
          "many": true
        },
        "EnumerationReference": {
          "type": "IfcPropertyEnumeration",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPropertyEnumeration": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcPropertyAbstraction"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EnumerationValues": {
          "type": "IfcValue",
          "reference": true,
          "many": true
        },
        "Unit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPropertyListValue": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcSimpleProperty"
      ],
      "fields": {
        "ListValues": {
          "type": "IfcValue",
          "reference": true,
          "many": true
        },
        "Unit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPropertyReferenceValue": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcSimpleProperty"
      ],
      "fields": {
        "UsageName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PropertyReference": {
          "type": "IfcObjectReferenceSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPropertySet": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertySetDefinition"
      ],
      "fields": {
        "HasProperties": {
          "type": "IfcProperty",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPropertySetDefinition": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertyDefinition",
        "IfcPropertySetDefinitionSelect"
      ],
      "fields": {
        "DefinesType": {
          "type": "IfcTypeObject",
          "reference": true,
          "many": true
        },
        "IsDefinedBy": {
          "type": "IfcRelDefinesByTemplate",
          "reference": true,
          "many": true
        },
        "DefinesOccurrence": {
          "type": "IfcRelDefinesByProperties",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPropertySetTemplate": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertyTemplateDefinition"
      ],
      "fields": {
        "TemplateType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ApplicableEntity": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasPropertyTemplates": {
          "type": "IfcPropertyTemplate",
          "reference": true,
          "many": true
        },
        "Defines": {
          "type": "IfcRelDefinesByTemplate",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPropertySingleValue": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcSimpleProperty"
      ],
      "fields": {
        "NominalValue": {
          "type": "IfcValue",
          "reference": true,
          "many": false
        },
        "Unit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcPropertyTableValue": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcSimpleProperty"
      ],
      "fields": {
        "DefiningValues": {
          "type": "IfcValue",
          "reference": true,
          "many": true
        },
        "DefinedValues": {
          "type": "IfcValue",
          "reference": true,
          "many": true
        },
        "Expression": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DefiningUnit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        },
        "DefinedUnit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        },
        "CurveInterpolation": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPropertyTemplate": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertyTemplateDefinition"
      ],
      "fields": {
        "PartOfComplexTemplate": {
          "type": "IfcComplexPropertyTemplate",
          "reference": true,
          "many": true
        },
        "PartOfPsetTemplate": {
          "type": "IfcPropertySetTemplate",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcPropertyTemplateDefinition": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertyDefinition"
      ],
      "fields": {}
    },
    "IfcProtectiveDevice": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowController"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcProtectiveDeviceTrippingUnit": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcDistributionControlElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcProtectiveDeviceTrippingUnitType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcDistributionControlElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcProtectiveDeviceType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowControllerType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcProxy": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcProduct"
      ],
      "fields": {
        "ProxyType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Tag": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPump": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowMovingDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPumpType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowMovingDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcQuantityArea": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcPhysicalSimpleQuantity"
      ],
      "fields": {
        "AreaValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "AreaValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Formula": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcQuantityCount": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcPhysicalSimpleQuantity"
      ],
      "fields": {
        "CountValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CountValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Formula": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcQuantityLength": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcPhysicalSimpleQuantity"
      ],
      "fields": {
        "LengthValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LengthValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Formula": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcQuantitySet": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertySetDefinition"
      ],
      "fields": {}
    },
    "IfcQuantityTime": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcPhysicalSimpleQuantity"
      ],
      "fields": {
        "TimeValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TimeValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Formula": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcQuantityVolume": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcPhysicalSimpleQuantity"
      ],
      "fields": {
        "VolumeValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "VolumeValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Formula": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcQuantityWeight": {
      "domain": "ifcquantityresource",
      "superclasses": [
        "IfcPhysicalSimpleQuantity"
      ],
      "fields": {
        "WeightValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WeightValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Formula": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRailing": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRailingType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRamp": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRampFlight": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRampFlightType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRampType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRationalBSplineCurveWithKnots": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBSplineCurveWithKnots"
      ],
      "fields": {
        "WeightsData": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "WeightsDataAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcRationalBSplineSurfaceWithKnots": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBSplineSurfaceWithKnots"
      ],
      "fields": {}
    },
    "IfcRectangleHollowProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcRectangleProfileDef"
      ],
      "fields": {
        "WallThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WallThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "InnerFilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "InnerFilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OuterFilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OuterFilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRectangleProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "XDim": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "XDimAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "YDim": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "YDimAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRectangularPyramid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcCsgPrimitive3D"
      ],
      "fields": {
        "XLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "XLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "YLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "YLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Height": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "HeightAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRectangularTrimmedSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundedSurface"
      ],
      "fields": {
        "BasisSurface": {
          "type": "IfcSurface",
          "reference": true,
          "many": false
        },
        "U1": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "U1AsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "V1": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "V1AsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "U2": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "U2AsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "V2": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "V2AsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Usense": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Vsense": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRecurrencePattern": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {
        "RecurrenceType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "DayComponent": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "WeekdayComponent": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "MonthComponent": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "Position": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "Interval": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "Occurrences": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "TimePeriods": {
          "type": "IfcTimePeriod",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcReference": {
      "domain": "ifcconstraintresource",
      "superclasses": [
        "IfcAppliedValueSelect",
        "IfcMetricValueSelect"
      ],
      "fields": {
        "TypeIdentifier": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "AttributeIdentifier": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "InstanceName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ListPositions": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "InnerReference": {
          "type": "IfcReference",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRegularTimeSeries": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcTimeSeries"
      ],
      "fields": {
        "TimeStep": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TimeStepAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Values": {
          "type": "IfcTimeSeriesValue",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcReinforcementBarProperties": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcPreDefinedProperties"
      ],
      "fields": {
        "TotalCrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TotalCrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SteelGrade": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BarSurface": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "EffectiveDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EffectiveDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "NominalBarDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalBarDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BarCount": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BarCountAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcReinforcementDefinitionProperties": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcPreDefinedPropertySet"
      ],
      "fields": {
        "DefinitionType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ReinforcementSectionDefinitions": {
          "type": "IfcSectionReinforcementProperties",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcReinforcingBar": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcReinforcingElement"
      ],
      "fields": {
        "NominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BarLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BarLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "BarSurface": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcReinforcingBarType": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcReinforcingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "NominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BarLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BarLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BarSurface": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "BendingShapeCode": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BendingParameters": {
          "type": "IfcBendingParameterSelect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcReinforcingElement": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcElementComponent"
      ],
      "fields": {
        "SteelGrade": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcReinforcingElementType": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcElementComponentType"
      ],
      "fields": {}
    },
    "IfcReinforcingMesh": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcReinforcingElement"
      ],
      "fields": {
        "MeshLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MeshLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MeshWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MeshWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongitudinalBarNominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LongitudinalBarNominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransverseBarNominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransverseBarNominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongitudinalBarCrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LongitudinalBarCrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransverseBarCrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransverseBarCrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongitudinalBarSpacing": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LongitudinalBarSpacingAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransverseBarSpacing": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransverseBarSpacingAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcReinforcingMeshType": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcReinforcingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "MeshLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MeshLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MeshWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MeshWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongitudinalBarNominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LongitudinalBarNominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransverseBarNominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransverseBarNominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongitudinalBarCrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LongitudinalBarCrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransverseBarCrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransverseBarCrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongitudinalBarSpacing": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LongitudinalBarSpacingAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransverseBarSpacing": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransverseBarSpacingAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BendingShapeCode": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BendingParameters": {
          "type": "IfcBendingParameterSelect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelAggregates": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelDecomposes"
      ],
      "fields": {
        "RelatingObject": {
          "type": "IfcObjectDefinition",
          "reference": true,
          "many": false
        },
        "RelatedObjects": {
          "type": "IfcObjectDefinition",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelAssigns": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelationship"
      ],
      "fields": {
        "RelatedObjects": {
          "type": "IfcObjectDefinition",
          "reference": true,
          "many": true
        },
        "RelatedObjectsType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRelAssignsToActor": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssigns"
      ],
      "fields": {
        "RelatingActor": {
          "type": "IfcActor",
          "reference": true,
          "many": false
        },
        "ActingRole": {
          "type": "IfcActorRole",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssignsToControl": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssigns"
      ],
      "fields": {
        "RelatingControl": {
          "type": "IfcControl",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssignsToGroup": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssigns"
      ],
      "fields": {
        "RelatingGroup": {
          "type": "IfcGroup",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssignsToGroupByFactor": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssignsToGroup"
      ],
      "fields": {
        "Factor": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FactorAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRelAssignsToProcess": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssigns"
      ],
      "fields": {
        "RelatingProcess": {
          "type": "IfcProcessSelect",
          "reference": true,
          "many": false
        },
        "QuantityInProcess": {
          "type": "IfcMeasureWithUnit",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssignsToProduct": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssigns"
      ],
      "fields": {
        "RelatingProduct": {
          "type": "IfcProductSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssignsToResource": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssigns"
      ],
      "fields": {
        "RelatingResource": {
          "type": "IfcResourceSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssociates": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelationship"
      ],
      "fields": {
        "RelatedObjects": {
          "type": "IfcDefinitionSelect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelAssociatesApproval": {
      "domain": "ifccontrolextension",
      "superclasses": [
        "IfcRelAssociates"
      ],
      "fields": {
        "RelatingApproval": {
          "type": "IfcApproval",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssociatesClassification": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssociates"
      ],
      "fields": {
        "RelatingClassification": {
          "type": "IfcClassificationSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssociatesConstraint": {
      "domain": "ifccontrolextension",
      "superclasses": [
        "IfcRelAssociates"
      ],
      "fields": {
        "Intent": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RelatingConstraint": {
          "type": "IfcConstraint",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssociatesDocument": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssociates"
      ],
      "fields": {
        "RelatingDocument": {
          "type": "IfcDocumentSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssociatesLibrary": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelAssociates"
      ],
      "fields": {
        "RelatingLibrary": {
          "type": "IfcLibrarySelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelAssociatesMaterial": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelAssociates"
      ],
      "fields": {
        "RelatingMaterial": {
          "type": "IfcMaterialSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelConnects": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelationship"
      ],
      "fields": {}
    },
    "IfcRelConnectsElements": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "ConnectionGeometry": {
          "type": "IfcConnectionGeometry",
          "reference": true,
          "many": false
        },
        "RelatingElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        },
        "RelatedElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelConnectsPathElements": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcRelConnectsElements"
      ],
      "fields": {
        "RelatingPriorities": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "RelatedPriorities": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "RelatedConnectionType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "RelatingConnectionType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRelConnectsPortToElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingPort": {
          "type": "IfcPort",
          "reference": true,
          "many": false
        },
        "RelatedElement": {
          "type": "IfcDistributionElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelConnectsPorts": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingPort": {
          "type": "IfcPort",
          "reference": true,
          "many": false
        },
        "RelatedPort": {
          "type": "IfcPort",
          "reference": true,
          "many": false
        },
        "RealizingElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelConnectsStructuralActivity": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingElement": {
          "type": "IfcStructuralActivityAssignmentSelect",
          "reference": true,
          "many": false
        },
        "RelatedStructuralActivity": {
          "type": "IfcStructuralActivity",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelConnectsStructuralMember": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingStructuralMember": {
          "type": "IfcStructuralMember",
          "reference": true,
          "many": false
        },
        "RelatedStructuralConnection": {
          "type": "IfcStructuralConnection",
          "reference": true,
          "many": false
        },
        "AppliedCondition": {
          "type": "IfcBoundaryCondition",
          "reference": true,
          "many": false
        },
        "AdditionalConditions": {
          "type": "IfcStructuralConnectionCondition",
          "reference": true,
          "many": false
        },
        "SupportedLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SupportedLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ConditionCoordinateSystem": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelConnectsWithEccentricity": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcRelConnectsStructuralMember"
      ],
      "fields": {
        "ConnectionConstraint": {
          "type": "IfcConnectionGeometry",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelConnectsWithRealizingElements": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnectsElements"
      ],
      "fields": {
        "RealizingElements": {
          "type": "IfcElement",
          "reference": true,
          "many": true
        },
        "ConnectionType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRelContainedInSpatialStructure": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatedElements": {
          "type": "IfcProduct",
          "reference": true,
          "many": true
        },
        "RelatingStructure": {
          "type": "IfcSpatialElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelCoversBldgElements": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingBuildingElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        },
        "RelatedCoverings": {
          "type": "IfcCovering",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelCoversSpaces": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingSpace": {
          "type": "IfcSpace",
          "reference": true,
          "many": false
        },
        "RelatedCoverings": {
          "type": "IfcCovering",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelDeclares": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelationship"
      ],
      "fields": {
        "RelatingContext": {
          "type": "IfcContext",
          "reference": true,
          "many": false
        },
        "RelatedDefinitions": {
          "type": "IfcDefinitionSelect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelDecomposes": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelationship"
      ],
      "fields": {}
    },
    "IfcRelDefines": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelationship"
      ],
      "fields": {}
    },
    "IfcRelDefinesByObject": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelDefines"
      ],
      "fields": {
        "RelatedObjects": {
          "type": "IfcObject",
          "reference": true,
          "many": true
        },
        "RelatingObject": {
          "type": "IfcObject",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelDefinesByProperties": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelDefines"
      ],
      "fields": {
        "RelatedObjects": {
          "type": "IfcObjectDefinition",
          "reference": true,
          "many": true
        },
        "RelatingPropertyDefinition": {
          "type": "IfcPropertySetDefinitionSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelDefinesByTemplate": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelDefines"
      ],
      "fields": {
        "RelatedPropertySets": {
          "type": "IfcPropertySetDefinition",
          "reference": true,
          "many": true
        },
        "RelatingTemplate": {
          "type": "IfcPropertySetTemplate",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelDefinesByType": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelDefines"
      ],
      "fields": {
        "RelatedObjects": {
          "type": "IfcObject",
          "reference": true,
          "many": true
        },
        "RelatingType": {
          "type": "IfcTypeObject",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelFillsElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingOpeningElement": {
          "type": "IfcOpeningElement",
          "reference": true,
          "many": false
        },
        "RelatedBuildingElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelFlowControlElements": {
      "domain": "ifcsharedbldgserviceelements",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatedControlElements": {
          "type": "IfcDistributionControlElement",
          "reference": true,
          "many": true
        },
        "RelatingFlowElement": {
          "type": "IfcDistributionFlowElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelInterferesElements": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        },
        "RelatedElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        },
        "InterferenceGeometry": {
          "type": "IfcConnectionGeometry",
          "reference": true,
          "many": false
        },
        "InterferenceType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ImpliedOrder": {
          "type": "boolean",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRelNests": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRelDecomposes"
      ],
      "fields": {
        "RelatingObject": {
          "type": "IfcObjectDefinition",
          "reference": true,
          "many": false
        },
        "RelatedObjects": {
          "type": "IfcObjectDefinition",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelProjectsElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelDecomposes"
      ],
      "fields": {
        "RelatingElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        },
        "RelatedFeatureElement": {
          "type": "IfcFeatureElementAddition",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelReferencedInSpatialStructure": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatedElements": {
          "type": "IfcProduct",
          "reference": true,
          "many": true
        },
        "RelatingStructure": {
          "type": "IfcSpatialElement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelSequence": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingProcess": {
          "type": "IfcProcess",
          "reference": true,
          "many": false
        },
        "RelatedProcess": {
          "type": "IfcProcess",
          "reference": true,
          "many": false
        },
        "TimeLag": {
          "type": "IfcLagTime",
          "reference": true,
          "many": false
        },
        "SequenceType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedSequenceType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRelServicesBuildings": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingSystem": {
          "type": "IfcSystem",
          "reference": true,
          "many": false
        },
        "RelatedBuildings": {
          "type": "IfcSpatialElement",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelSpaceBoundary": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelConnects"
      ],
      "fields": {
        "RelatingSpace": {
          "type": "IfcSpaceBoundarySelect",
          "reference": true,
          "many": false
        },
        "RelatedBuildingElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        },
        "ConnectionGeometry": {
          "type": "IfcConnectionGeometry",
          "reference": true,
          "many": false
        },
        "PhysicalOrVirtualBoundary": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "InternalOrExternalBoundary": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRelSpaceBoundary1stLevel": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelSpaceBoundary"
      ],
      "fields": {
        "ParentBoundary": {
          "type": "IfcRelSpaceBoundary1stLevel",
          "reference": true,
          "many": false
        },
        "InnerBoundaries": {
          "type": "IfcRelSpaceBoundary1stLevel",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelSpaceBoundary2ndLevel": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelSpaceBoundary1stLevel"
      ],
      "fields": {
        "CorrespondingBoundary": {
          "type": "IfcRelSpaceBoundary2ndLevel",
          "reference": true,
          "many": false
        },
        "Corresponds": {
          "type": "IfcRelSpaceBoundary2ndLevel",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRelVoidsElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcRelDecomposes"
      ],
      "fields": {
        "RelatingBuildingElement": {
          "type": "IfcElement",
          "reference": true,
          "many": false
        },
        "RelatedOpeningElement": {
          "type": "IfcFeatureElementSubtraction",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRelationship": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcRoot"
      ],
      "fields": {}
    },
    "IfcReparametrisedCompositeCurveSegment": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcCompositeCurveSegment"
      ],
      "fields": {
        "ParamLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ParamLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRepresentation": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcLayeredItem"
      ],
      "fields": {
        "ContextOfItems": {
          "type": "IfcRepresentationContext",
          "reference": true,
          "many": false
        },
        "RepresentationIdentifier": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RepresentationType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Items": {
          "type": "IfcRepresentationItem",
          "reference": true,
          "many": true
        },
        "RepresentationMap": {
          "type": "IfcRepresentationMap",
          "reference": true,
          "many": true
        },
        "LayerAssignments": {
          "type": "IfcPresentationLayerAssignment",
          "reference": true,
          "many": true
        },
        "OfProductRepresentation": {
          "type": "IfcProductRepresentation",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRepresentationContext": {
      "domain": "ifcrepresentationresource",
      "superclasses": [],
      "fields": {
        "ContextIdentifier": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ContextType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RepresentationsInContext": {
          "type": "IfcRepresentation",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRepresentationItem": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcLayeredItem"
      ],
      "fields": {
        "LayerAssignment": {
          "type": "IfcPresentationLayerAssignment",
          "reference": true,
          "many": true
        },
        "StyledByItem": {
          "type": "IfcStyledItem",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcRepresentationMap": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcProductRepresentationSelect"
      ],
      "fields": {
        "MappingOrigin": {
          "type": "IfcAxis2Placement",
          "reference": true,
          "many": false
        },
        "MappedRepresentation": {
          "type": "IfcRepresentation",
          "reference": true,
          "many": false
        },
        "HasShapeAspects": {
          "type": "IfcShapeAspect",
          "reference": true,
          "many": true
        },
        "MapUsage": {
          "type": "IfcMappedItem",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcResource": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObject",
        "IfcResourceSelect"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongDescription": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ResourceOf": {
          "type": "IfcRelAssignsToResource",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcResourceApprovalRelationship": {
      "domain": "ifcapprovalresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "RelatedResourceObjects": {
          "type": "IfcResourceObjectSelect",
          "reference": true,
          "many": true
        },
        "RelatingApproval": {
          "type": "IfcApproval",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcResourceConstraintRelationship": {
      "domain": "ifcconstraintresource",
      "superclasses": [
        "IfcResourceLevelRelationship"
      ],
      "fields": {
        "RelatingConstraint": {
          "type": "IfcConstraint",
          "reference": true,
          "many": false
        },
        "RelatedResourceObjects": {
          "type": "IfcResourceObjectSelect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcResourceLevelRelationship": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcResourceTime": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSchedulingTime"
      ],
      "fields": {
        "ScheduleWork": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ScheduleUsage": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ScheduleUsageAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ScheduleStart": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ScheduleFinish": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ScheduleContour": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LevelingDelay": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "IsOverAllocated": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "StatusTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ActualWork": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ActualUsage": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ActualUsageAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ActualStart": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ActualFinish": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RemainingWork": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RemainingUsage": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RemainingUsageAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Completion": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CompletionAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRevolvedAreaSolid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSweptAreaSolid"
      ],
      "fields": {
        "Axis": {
          "type": "IfcAxis1Placement",
          "reference": true,
          "many": false
        },
        "Angle": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "AngleAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRevolvedAreaSolidTapered": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcRevolvedAreaSolid"
      ],
      "fields": {
        "EndSweptArea": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcRightCircularCone": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcCsgPrimitive3D"
      ],
      "fields": {
        "Height": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "HeightAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "BottomRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BottomRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRightCircularCylinder": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcCsgPrimitive3D"
      ],
      "fields": {
        "Height": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "HeightAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Radius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRoof": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRoofType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRoot": {
      "domain": "ifckernel",
      "superclasses": [],
      "fields": {
        "GlobalId": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OwnerHistory": {
          "type": "IfcOwnerHistory",
          "reference": true,
          "many": false
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRoundedRectangleProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcRectangleProfileDef"
      ],
      "fields": {
        "RoundingRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RoundingRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSIUnit": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcNamedUnit"
      ],
      "fields": {
        "Prefix": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Name": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSanitaryTerminal": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSanitaryTerminalType": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSchedulingTime": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DataOrigin": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedDataOrigin": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSectionProperties": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcPreDefinedProperties"
      ],
      "fields": {
        "SectionType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "StartProfile": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        },
        "EndProfile": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSectionReinforcementProperties": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcPreDefinedProperties"
      ],
      "fields": {
        "LongitudinalStartPosition": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LongitudinalStartPositionAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongitudinalEndPosition": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LongitudinalEndPositionAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransversePosition": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransversePositionAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ReinforcementRole": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "SectionDefinition": {
          "type": "IfcSectionProperties",
          "reference": true,
          "many": false
        },
        "CrossSectionReinforcementDefinitions": {
          "type": "IfcReinforcementBarProperties",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcSectionedSpine": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "SpineCurve": {
          "type": "IfcCompositeCurve",
          "reference": true,
          "many": false
        },
        "CrossSections": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": true
        },
        "CrossSectionPositions": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": true
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSensor": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSensorType": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcShadingDevice": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcShadingDeviceType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcShapeAspect": {
      "domain": "ifcrepresentationresource",
      "superclasses": [],
      "fields": {
        "ShapeRepresentations": {
          "type": "IfcShapeModel",
          "reference": true,
          "many": true
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ProductDefinitional": {
          "type": "boolean",
          "reference": false,
          "many": false
        },
        "PartOfProductDefinitionShape": {
          "type": "IfcProductRepresentationSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcShapeModel": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcRepresentation"
      ],
      "fields": {
        "OfShapeAspect": {
          "type": "IfcShapeAspect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcShapeRepresentation": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcShapeModel"
      ],
      "fields": {}
    },
    "IfcShellBasedSurfaceModel": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "SbsmBoundary": {
          "type": "IfcShell",
          "reference": true,
          "many": true
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSimpleProperty": {
      "domain": "ifcpropertyresource",
      "superclasses": [
        "IfcProperty"
      ],
      "fields": {}
    },
    "IfcSimplePropertyTemplate": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcPropertyTemplate"
      ],
      "fields": {
        "TemplateType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PrimaryMeasureType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SecondaryMeasureType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Enumerators": {
          "type": "IfcPropertyEnumeration",
          "reference": true,
          "many": false
        },
        "PrimaryUnit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        },
        "SecondaryUnit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        },
        "Expression": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "AccessState": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSite": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialStructureElement"
      ],
      "fields": {
        "RefLatitude": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "RefLongitude": {
          "type": "int",
          "reference": false,
          "many": true
        },
        "RefElevation": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RefElevationAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LandTitleNumber": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SiteAddress": {
          "type": "IfcPostalAddress",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSlab": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSlabElementedCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcSlab"
      ],
      "fields": {}
    },
    "IfcSlabStandardCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcSlab"
      ],
      "fields": {}
    },
    "IfcSlabType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSlippageConnectionCondition": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralConnectionCondition"
      ],
      "fields": {
        "SlippageX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SlippageXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SlippageY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SlippageYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SlippageZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SlippageZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSolarDevice": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSolarDeviceType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSolidModel": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcBooleanOperand",
        "IfcSolidOrShell"
      ],
      "fields": {
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpace": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialStructureElement",
        "IfcSpaceBoundarySelect"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ElevationWithFlooring": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ElevationWithFlooringAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasCoverings": {
          "type": "IfcRelCoversSpaces",
          "reference": true,
          "many": true
        },
        "BoundedBy": {
          "type": "IfcRelSpaceBoundary",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcSpaceHeater": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpaceHeaterType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpaceType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialStructureElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "LongName": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpatialElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcProduct"
      ],
      "fields": {
        "LongName": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ContainsElements": {
          "type": "IfcRelContainedInSpatialStructure",
          "reference": true,
          "many": true
        },
        "ServicedBySystems": {
          "type": "IfcRelServicesBuildings",
          "reference": true,
          "many": true
        },
        "ReferencesElements": {
          "type": "IfcRelReferencedInSpatialStructure",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcSpatialElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcTypeProduct"
      ],
      "fields": {
        "ElementType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpatialStructureElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialElement"
      ],
      "fields": {
        "CompositionType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpatialStructureElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialElementType"
      ],
      "fields": {}
    },
    "IfcSpatialZone": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpatialZoneType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSpatialElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "LongName": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSphere": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcCsgPrimitive3D"
      ],
      "fields": {
        "Radius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStackTerminal": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStackTerminalType": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStair": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStairFlight": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "NumberOfRiser": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "NumberOfTreads": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "RiserHeight": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RiserHeightAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TreadLength": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TreadLengthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStairFlightType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStairType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralAction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralActivity"
      ],
      "fields": {
        "DestabilizingLoad": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralActivity": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcProduct"
      ],
      "fields": {
        "AppliedLoad": {
          "type": "IfcStructuralLoad",
          "reference": true,
          "many": false
        },
        "GlobalOrLocal": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "AssignedToStructuralItem": {
          "type": "IfcRelConnectsStructuralActivity",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcStructuralAnalysisModel": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcSystem"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "OrientationOf2DPlane": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        },
        "LoadedBy": {
          "type": "IfcStructuralLoadGroup",
          "reference": true,
          "many": true
        },
        "HasResults": {
          "type": "IfcStructuralResultGroup",
          "reference": true,
          "many": true
        },
        "SharedPlacement": {
          "type": "IfcObjectPlacement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcStructuralConnection": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralItem"
      ],
      "fields": {
        "AppliedCondition": {
          "type": "IfcBoundaryCondition",
          "reference": true,
          "many": false
        },
        "ConnectsStructuralMembers": {
          "type": "IfcRelConnectsStructuralMember",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcStructuralConnectionCondition": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralCurveAction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralAction"
      ],
      "fields": {
        "ProjectedOrTrue": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralCurveConnection": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralConnection"
      ],
      "fields": {
        "Axis": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcStructuralCurveMember": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralMember"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Axis": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcStructuralCurveMemberVarying": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralCurveMember"
      ],
      "fields": {}
    },
    "IfcStructuralCurveReaction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralReaction"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralItem": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcProduct",
        "IfcStructuralActivityAssignmentSelect"
      ],
      "fields": {
        "AssignedStructuralActivity": {
          "type": "IfcRelConnectsStructuralActivity",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcStructuralLinearAction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralCurveAction"
      ],
      "fields": {}
    },
    "IfcStructuralLoad": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralLoadCase": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralLoadGroup"
      ],
      "fields": {
        "SelfWeightCoefficients": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "SelfWeightCoefficientsAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcStructuralLoadConfiguration": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoad"
      ],
      "fields": {
        "Values": {
          "type": "IfcStructuralLoadOrResult",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcStructuralLoadGroup": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcGroup"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ActionType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ActionSource": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Coefficient": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CoefficientAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Purpose": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SourceOfResultGroup": {
          "type": "IfcStructuralResultGroup",
          "reference": true,
          "many": true
        },
        "LoadGroupFor": {
          "type": "IfcStructuralAnalysisModel",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcStructuralLoadLinearForce": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadStatic"
      ],
      "fields": {
        "LinearForceX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LinearForceXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LinearForceY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LinearForceYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LinearForceZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LinearForceZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LinearMomentX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LinearMomentXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LinearMomentY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LinearMomentYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LinearMomentZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LinearMomentZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralLoadOrResult": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoad"
      ],
      "fields": {}
    },
    "IfcStructuralLoadPlanarForce": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadStatic"
      ],
      "fields": {
        "PlanarForceX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PlanarForceXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PlanarForceY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PlanarForceYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PlanarForceZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PlanarForceZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralLoadSingleDisplacement": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadStatic"
      ],
      "fields": {
        "DisplacementX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DisplacementXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DisplacementY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DisplacementYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DisplacementZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DisplacementZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RotationalDisplacementRX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RotationalDisplacementRXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RotationalDisplacementRY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RotationalDisplacementRYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RotationalDisplacementRZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RotationalDisplacementRZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralLoadSingleDisplacementDistortion": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadSingleDisplacement"
      ],
      "fields": {
        "Distortion": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DistortionAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralLoadSingleForce": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadStatic"
      ],
      "fields": {
        "ForceX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ForceXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ForceY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ForceYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ForceZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ForceZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MomentX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MomentXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MomentY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MomentYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MomentZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MomentZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralLoadSingleForceWarping": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadSingleForce"
      ],
      "fields": {
        "WarpingMoment": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WarpingMomentAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralLoadStatic": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadOrResult"
      ],
      "fields": {}
    },
    "IfcStructuralLoadTemperature": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadStatic"
      ],
      "fields": {
        "DeltaTConstant": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DeltaTConstantAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DeltaTY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DeltaTYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DeltaTZ": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DeltaTZAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralMember": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralItem"
      ],
      "fields": {
        "ConnectedBy": {
          "type": "IfcRelConnectsStructuralMember",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcStructuralPlanarAction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralSurfaceAction"
      ],
      "fields": {}
    },
    "IfcStructuralPointAction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralAction"
      ],
      "fields": {}
    },
    "IfcStructuralPointConnection": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralConnection"
      ],
      "fields": {
        "ConditionCoordinateSystem": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcStructuralPointReaction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralReaction"
      ],
      "fields": {}
    },
    "IfcStructuralReaction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralActivity"
      ],
      "fields": {}
    },
    "IfcStructuralResultGroup": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcGroup"
      ],
      "fields": {
        "TheoryType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ResultForLoadGroup": {
          "type": "IfcStructuralLoadGroup",
          "reference": true,
          "many": false
        },
        "IsLinear": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ResultGroupFor": {
          "type": "IfcStructuralAnalysisModel",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcStructuralSurfaceAction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralAction"
      ],
      "fields": {
        "ProjectedOrTrue": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralSurfaceConnection": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralConnection"
      ],
      "fields": {}
    },
    "IfcStructuralSurfaceMember": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralMember"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Thickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStructuralSurfaceMemberVarying": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralSurfaceMember"
      ],
      "fields": {}
    },
    "IfcStructuralSurfaceReaction": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [
        "IfcStructuralReaction"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStyleModel": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcRepresentation"
      ],
      "fields": {}
    },
    "IfcStyledItem": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcRepresentationItem"
      ],
      "fields": {
        "Item": {
          "type": "IfcRepresentationItem",
          "reference": true,
          "many": false
        },
        "Styles": {
          "type": "IfcStyleAssignmentSelect",
          "reference": true,
          "many": true
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcStyledRepresentation": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcStyleModel"
      ],
      "fields": {}
    },
    "IfcSubContractResource": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResource"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSubContractResourceType": {
      "domain": "ifcconstructionmgmtdomain",
      "superclasses": [
        "IfcConstructionResourceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSubedge": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcEdge"
      ],
      "fields": {
        "ParentEdge": {
          "type": "IfcEdge",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcGeometricSetSelect",
        "IfcSurfaceOrFaceSurface"
      ],
      "fields": {
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSurfaceCurveSweptAreaSolid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSweptAreaSolid"
      ],
      "fields": {
        "Directrix": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "StartParam": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "StartParamAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EndParam": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EndParamAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ReferenceSurface": {
          "type": "IfcSurface",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSurfaceFeature": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcFeatureElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSurfaceOfLinearExtrusion": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcSweptSurface"
      ],
      "fields": {
        "ExtrudedDirection": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        },
        "Depth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSurfaceOfRevolution": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcSweptSurface"
      ],
      "fields": {
        "AxisPosition": {
          "type": "IfcAxis1Placement",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSurfaceReinforcementArea": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [
        "IfcStructuralLoadOrResult"
      ],
      "fields": {
        "SurfaceReinforcement1": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "SurfaceReinforcement1AsString": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "SurfaceReinforcement2": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "SurfaceReinforcement2AsString": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "ShearReinforcement": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "ShearReinforcementAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSurfaceStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationStyle",
        "IfcPresentationStyleSelect"
      ],
      "fields": {
        "Side": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Styles": {
          "type": "IfcSurfaceStyleElementSelect",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcSurfaceStyleLighting": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem",
        "IfcSurfaceStyleElementSelect"
      ],
      "fields": {
        "DiffuseTransmissionColour": {
          "type": "IfcColourRgb",
          "reference": true,
          "many": false
        },
        "DiffuseReflectionColour": {
          "type": "IfcColourRgb",
          "reference": true,
          "many": false
        },
        "TransmissionColour": {
          "type": "IfcColourRgb",
          "reference": true,
          "many": false
        },
        "ReflectanceColour": {
          "type": "IfcColourRgb",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSurfaceStyleRefraction": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem",
        "IfcSurfaceStyleElementSelect"
      ],
      "fields": {
        "RefractionIndex": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RefractionIndexAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DispersionFactor": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DispersionFactorAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSurfaceStyleRendering": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcSurfaceStyleShading"
      ],
      "fields": {
        "Transparency": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransparencyAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "DiffuseColour": {
          "type": "IfcColourOrFactor",
          "reference": true,
          "many": false
        },
        "TransmissionColour": {
          "type": "IfcColourOrFactor",
          "reference": true,
          "many": false
        },
        "DiffuseTransmissionColour": {
          "type": "IfcColourOrFactor",
          "reference": true,
          "many": false
        },
        "ReflectionColour": {
          "type": "IfcColourOrFactor",
          "reference": true,
          "many": false
        },
        "SpecularColour": {
          "type": "IfcColourOrFactor",
          "reference": true,
          "many": false
        },
        "SpecularHighlight": {
          "type": "IfcSpecularHighlightSelect",
          "reference": true,
          "many": false
        },
        "ReflectanceMethod": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSurfaceStyleShading": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem",
        "IfcSurfaceStyleElementSelect"
      ],
      "fields": {
        "SurfaceColour": {
          "type": "IfcColourRgb",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSurfaceStyleWithTextures": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem",
        "IfcSurfaceStyleElementSelect"
      ],
      "fields": {
        "Textures": {
          "type": "IfcSurfaceTexture",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcSurfaceTexture": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {
        "RepeatS": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "RepeatT": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Mode": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TextureTransform": {
          "type": "IfcCartesianTransformationOperator2D",
          "reference": true,
          "many": false
        },
        "Parameter": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "IsMappedBy": {
          "type": "IfcTextureCoordinate",
          "reference": true,
          "many": true
        },
        "UsedInStyles": {
          "type": "IfcSurfaceStyleWithTextures",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcSweptAreaSolid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSolidModel"
      ],
      "fields": {
        "SweptArea": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        },
        "Position": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSweptDiskSolid": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSolidModel"
      ],
      "fields": {
        "Directrix": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "Radius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "RadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "InnerRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "InnerRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "StartParam": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "StartParamAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EndParam": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EndParamAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSweptDiskSolidPolygonal": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcSweptDiskSolid"
      ],
      "fields": {
        "FilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSweptSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcSurface"
      ],
      "fields": {
        "SweptCurve": {
          "type": "IfcProfileDef",
          "reference": true,
          "many": false
        },
        "Position": {
          "type": "IfcAxis2Placement3D",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcSwitchingDevice": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowController"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSwitchingDeviceType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcFlowControllerType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSystem": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcGroup"
      ],
      "fields": {
        "ServicesBuildings": {
          "type": "IfcRelServicesBuildings",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcSystemFurnitureElement": {
      "domain": "ifcsharedfacilitieselements",
      "superclasses": [
        "IfcFurnishingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSystemFurnitureElementType": {
      "domain": "ifcsharedfacilitieselements",
      "superclasses": [
        "IfcFurnishingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTShapeProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "Depth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WebThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WebThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeEdgeRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeEdgeRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WebEdgeRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WebEdgeRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WebSlope": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WebSlopeAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeSlope": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeSlopeAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTable": {
      "domain": "ifcutilityresource",
      "superclasses": [
        "IfcMetricValueSelect",
        "IfcObjectReferenceSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Rows": {
          "type": "IfcTableRow",
          "reference": true,
          "many": true
        },
        "Columns": {
          "type": "IfcTableColumn",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcTableColumn": {
      "domain": "ifcutilityresource",
      "superclasses": [],
      "fields": {
        "Identifier": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Unit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        },
        "ReferencePath": {
          "type": "IfcReference",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcTableRow": {
      "domain": "ifcutilityresource",
      "superclasses": [],
      "fields": {
        "RowCells": {
          "type": "IfcValue",
          "reference": true,
          "many": true
        },
        "IsHeading": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "OfTable": {
          "type": "IfcTable",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcTank": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowStorageDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTankType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowStorageDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTask": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcProcess"
      ],
      "fields": {
        "Status": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WorkMethod": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "IsMilestone": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Priority": {
          "type": "int",
          "reference": false,
          "many": false
        },
        "TaskTime": {
          "type": "IfcTaskTime",
          "reference": true,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTaskTime": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSchedulingTime"
      ],
      "fields": {
        "DurationType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ScheduleDuration": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ScheduleStart": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ScheduleFinish": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EarlyStart": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EarlyFinish": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LateStart": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LateFinish": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FreeFloat": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TotalFloat": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "IsCritical": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "StatusTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ActualDuration": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ActualStart": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ActualFinish": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "RemainingTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Completion": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CompletionAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTaskTimeRecurring": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcTaskTime"
      ],
      "fields": {
        "Recurrance": {
          "type": "IfcRecurrencePattern",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcTaskType": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcTypeProcess"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "WorkMethod": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTelecomAddress": {
      "domain": "ifcactorresource",
      "superclasses": [
        "IfcAddress"
      ],
      "fields": {
        "TelephoneNumbers": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "FacsimileNumbers": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "PagerNumber": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ElectronicMailAddresses": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "WWWHomePageURL": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MessagingIDs": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcTendon": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcReinforcingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "NominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TensionForce": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TensionForceAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PreStress": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "PreStressAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FrictionCoefficient": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FrictionCoefficientAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "AnchorageSlip": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "AnchorageSlipAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MinCurvatureRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MinCurvatureRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTendonAnchor": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcReinforcingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTendonAnchorType": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcReinforcingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTendonType": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcReinforcingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "NominalDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "NominalDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "CrossSectionArea": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "CrossSectionAreaAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SheethDiameter": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SheethDiameterAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTessellatedFaceSet": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcTessellatedItem"
      ],
      "fields": {
        "Coordinates": {
          "type": "IfcCartesianPointList3D",
          "reference": true,
          "many": false
        },
        "Closed": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "HasColours": {
          "type": "IfcIndexedColourMap",
          "reference": true,
          "many": true
        },
        "HasTextures": {
          "type": "IfcIndexedTextureMap",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcTessellatedItem": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {}
    },
    "IfcTextLiteral": {
      "domain": "ifcpresentationdefinitionresource",
      "superclasses": [
        "IfcGeometricRepresentationItem"
      ],
      "fields": {
        "Literal": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Placement": {
          "type": "IfcAxis2Placement",
          "reference": true,
          "many": false
        },
        "Path": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTextLiteralWithExtent": {
      "domain": "ifcpresentationdefinitionresource",
      "superclasses": [
        "IfcTextLiteral"
      ],
      "fields": {
        "Extent": {
          "type": "IfcPlanarExtent",
          "reference": true,
          "many": false
        },
        "BoxAlignment": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTextStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationStyle",
        "IfcPresentationStyleSelect"
      ],
      "fields": {
        "TextCharacterAppearance": {
          "type": "IfcTextStyleForDefinedFont",
          "reference": true,
          "many": false
        },
        "TextStyle": {
          "type": "IfcTextStyleTextModel",
          "reference": true,
          "many": false
        },
        "TextFontStyle": {
          "type": "IfcTextFontSelect",
          "reference": true,
          "many": false
        },
        "ModelOrDraughting": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTextStyleFontModel": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPreDefinedTextFont"
      ],
      "fields": {
        "FontFamily": {
          "type": "string",
          "reference": false,
          "many": true
        },
        "FontStyle": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FontVariant": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FontWeight": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FontSize": {
          "type": "IfcSizeSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcTextStyleForDefinedFont": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {
        "Colour": {
          "type": "IfcColour",
          "reference": true,
          "many": false
        },
        "BackgroundColour": {
          "type": "IfcColour",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcTextStyleTextModel": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {
        "TextIndent": {
          "type": "IfcSizeSelect",
          "reference": true,
          "many": false
        },
        "TextAlign": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TextDecoration": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LetterSpacing": {
          "type": "IfcSizeSelect",
          "reference": true,
          "many": false
        },
        "WordSpacing": {
          "type": "IfcSizeSelect",
          "reference": true,
          "many": false
        },
        "TextTransform": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LineHeight": {
          "type": "IfcSizeSelect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcTextureCoordinate": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {
        "Maps": {
          "type": "IfcSurfaceTexture",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcTextureCoordinateGenerator": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcTextureCoordinate"
      ],
      "fields": {
        "Mode": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Parameter": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "ParameterAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcTextureMap": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcTextureCoordinate"
      ],
      "fields": {
        "Vertices": {
          "type": "IfcTextureVertex",
          "reference": true,
          "many": true
        },
        "MappedTo": {
          "type": "IfcFace",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcTextureVertex": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {
        "Coordinates": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "CoordinatesAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcTextureVertexList": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationItem"
      ],
      "fields": {}
    },
    "IfcTimePeriod": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {
        "StartTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EndTime": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTimeSeries": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcMetricValueSelect",
        "IfcObjectReferenceSelect",
        "IfcResourceObjectSelect"
      ],
      "fields": {
        "Name": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Description": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "StartTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EndTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TimeSeriesDataType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "DataOrigin": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedDataOrigin": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Unit": {
          "type": "IfcUnit",
          "reference": true,
          "many": false
        },
        "HasExternalReference": {
          "type": "IfcExternalReferenceRelationship",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcTimeSeriesValue": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {
        "ListValues": {
          "type": "IfcValue",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcTopologicalRepresentationItem": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcRepresentationItem"
      ],
      "fields": {}
    },
    "IfcTopologyRepresentation": {
      "domain": "ifcrepresentationresource",
      "superclasses": [
        "IfcShapeModel"
      ],
      "fields": {}
    },
    "IfcTransformer": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTransformerType": {
      "domain": "ifcelectricaldomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTransportElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTransportElementType": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTrapeziumProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "BottomXDim": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "BottomXDimAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TopXDim": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TopXDimAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "YDim": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "YDimAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TopXOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TopXOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTriangulatedFaceSet": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [
        "IfcTessellatedFaceSet"
      ],
      "fields": {}
    },
    "IfcTrimmedCurve": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcBoundedCurve"
      ],
      "fields": {
        "BasisCurve": {
          "type": "IfcCurve",
          "reference": true,
          "many": false
        },
        "Trim1": {
          "type": "IfcTrimmingSelect",
          "reference": true,
          "many": true
        },
        "Trim2": {
          "type": "IfcTrimmingSelect",
          "reference": true,
          "many": true
        },
        "SenseAgreement": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "MasterRepresentation": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTubeBundle": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTubeBundleType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTypeObject": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcObjectDefinition"
      ],
      "fields": {
        "ApplicableOccurrence": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "HasPropertySets": {
          "type": "IfcPropertySetDefinition",
          "reference": true,
          "many": true
        },
        "Types": {
          "type": "IfcRelDefinesByType",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcTypeProcess": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcTypeObject",
        "IfcProcessSelect"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongDescription": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ProcessType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OperatesOn": {
          "type": "IfcRelAssignsToProcess",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcTypeProduct": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcTypeObject",
        "IfcProductSelect"
      ],
      "fields": {
        "RepresentationMaps": {
          "type": "IfcRepresentationMap",
          "reference": true,
          "many": true
        },
        "Tag": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ReferencedBy": {
          "type": "IfcRelAssignsToProduct",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcTypeResource": {
      "domain": "ifckernel",
      "superclasses": [
        "IfcTypeObject",
        "IfcResourceSelect"
      ],
      "fields": {
        "Identification": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LongDescription": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ResourceType": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ResourceOf": {
          "type": "IfcRelAssignsToResource",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcUShapeProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "Depth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WebThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WebThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EdgeRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EdgeRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeSlope": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeSlopeAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcUnitAssignment": {
      "domain": "ifcmeasureresource",
      "superclasses": [],
      "fields": {
        "Units": {
          "type": "IfcUnit",
          "reference": true,
          "many": true
        }
      }
    },
    "IfcUnitaryControlElement": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcUnitaryControlElementType": {
      "domain": "ifcbuildingcontrolsdomain",
      "superclasses": [
        "IfcDistributionControlElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcUnitaryEquipment": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDevice"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcUnitaryEquipmentType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcEnergyConversionDeviceType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcValve": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowController"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcValveType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcFlowControllerType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcVector": {
      "domain": "ifcgeometryresource",
      "superclasses": [
        "IfcGeometricRepresentationItem",
        "IfcHatchLineDistanceSelect",
        "IfcVectorOrDirection"
      ],
      "fields": {
        "Orientation": {
          "type": "IfcDirection",
          "reference": true,
          "many": false
        },
        "Magnitude": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MagnitudeAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Dim": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcVertex": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcTopologicalRepresentationItem"
      ],
      "fields": {}
    },
    "IfcVertexLoop": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcLoop"
      ],
      "fields": {
        "LoopVertex": {
          "type": "IfcVertex",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcVertexPoint": {
      "domain": "ifctopologyresource",
      "superclasses": [
        "IfcVertex",
        "IfcPointOrVertexPoint"
      ],
      "fields": {
        "VertexGeometry": {
          "type": "IfcPoint",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcVibrationIsolator": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcElementComponent"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcVibrationIsolatorType": {
      "domain": "ifchvacdomain",
      "superclasses": [
        "IfcElementComponentType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcVirtualElement": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcElement"
      ],
      "fields": {}
    },
    "IfcVirtualGridIntersection": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [
        "IfcGridPlacementDirectionSelect"
      ],
      "fields": {
        "IntersectingAxes": {
          "type": "IfcGridAxis",
          "reference": true,
          "many": true
        },
        "OffsetDistances": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "OffsetDistancesAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcVoidingFeature": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [
        "IfcFeatureElementSubtraction"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWall": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWallElementedCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcWall"
      ],
      "fields": {}
    },
    "IfcWallStandardCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcWall"
      ],
      "fields": {}
    },
    "IfcWallType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWasteTerminal": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTerminal"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWasteTerminalType": {
      "domain": "ifcplumbingfireprotectiondomain",
      "superclasses": [
        "IfcFlowTerminalType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWindow": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElement"
      ],
      "fields": {
        "OverallHeight": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OverallHeightAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "OverallWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "OverallWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PartitioningType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedPartitioningType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWindowLiningProperties": {
      "domain": "ifcarchitecturedomain",
      "superclasses": [
        "IfcPreDefinedPropertySet"
      ],
      "fields": {
        "LiningDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LiningThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TransomThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "TransomThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "MullionThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "MullionThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FirstTransomOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FirstTransomOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SecondTransomOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SecondTransomOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FirstMullionOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FirstMullionOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "SecondMullionOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "SecondMullionOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ShapeAspectStyle": {
          "type": "IfcShapeAspect",
          "reference": true,
          "many": false
        },
        "LiningOffset": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningOffsetAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LiningToPanelOffsetX": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningToPanelOffsetXAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "LiningToPanelOffsetY": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "LiningToPanelOffsetYAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWindowPanelProperties": {
      "domain": "ifcarchitecturedomain",
      "superclasses": [
        "IfcPreDefinedPropertySet"
      ],
      "fields": {
        "OperationType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PanelPosition": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "FrameDepth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FrameDepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FrameThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FrameThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "ShapeAspectStyle": {
          "type": "IfcShapeAspect",
          "reference": true,
          "many": false
        }
      }
    },
    "IfcWindowStandardCase": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcWindow"
      ],
      "fields": {}
    },
    "IfcWindowStyle": {
      "domain": "ifcarchitecturedomain",
      "superclasses": [
        "IfcTypeProduct"
      ],
      "fields": {
        "ConstructionType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "OperationType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ParameterTakesPrecedence": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "Sizeable": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWindowType": {
      "domain": "ifcsharedbldgelements",
      "superclasses": [
        "IfcBuildingElementType"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "PartitioningType": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "ParameterTakesPrecedence": {
          "type": "enum",
          "reference": false,
          "many": false
        },
        "UserDefinedPartitioningType": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWorkCalendar": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcControl"
      ],
      "fields": {
        "WorkingTimes": {
          "type": "IfcWorkTime",
          "reference": true,
          "many": true
        },
        "ExceptionTimes": {
          "type": "IfcWorkTime",
          "reference": true,
          "many": true
        },
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWorkControl": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcControl"
      ],
      "fields": {
        "CreationDate": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Creators": {
          "type": "IfcPerson",
          "reference": true,
          "many": true
        },
        "Purpose": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Duration": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "TotalFloat": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "StartTime": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FinishTime": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWorkPlan": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcWorkControl"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWorkSchedule": {
      "domain": "ifcprocessextension",
      "superclasses": [
        "IfcWorkControl"
      ],
      "fields": {
        "PredefinedType": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWorkTime": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSchedulingTime"
      ],
      "fields": {
        "RecurrencePattern": {
          "type": "IfcRecurrencePattern",
          "reference": true,
          "many": false
        },
        "Start": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "Finish": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcZShapeProfileDef": {
      "domain": "ifcprofileresource",
      "superclasses": [
        "IfcParameterizedProfileDef"
      ],
      "fields": {
        "Depth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "DepthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeWidth": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeWidthAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "WebThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "WebThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FlangeThickness": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FlangeThicknessAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "FilletRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "FilletRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        },
        "EdgeRadius": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "EdgeRadiusAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcZone": {
      "domain": "ifcproductextension",
      "superclasses": [
        "IfcSystem"
      ],
      "fields": {
        "LongName": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAbsorbedDoseMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAccelerationMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAmountOfSubstanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAngularVelocityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAreaDensityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcAreaMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBoolean": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcModulusOfRotationalSubgradeReactionSelect",
        "IfcModulusOfSubgradeReactionSelect",
        "IfcModulusOfTranslationalSubgradeReactionSelect",
        "IfcRotationalStiffnessSelect",
        "IfcSimpleValue",
        "IfcTranslationalStiffnessSelect",
        "IfcWarpingStiffnessSelect",
        "IfcValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCardinalPointReference": {
      "domain": "ifcmaterialresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcContextDependentMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCountMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcCurvatureMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDate": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDateTime": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDayInMonthNumber": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDayInWeekNumber": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDescriptiveMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue",
        "IfcSizeSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDimensionCount": {
      "domain": "ifcgeometryresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDoseEquivalentMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDuration": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSimpleValue",
        "IfcTimeOrRatioSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcDynamicViscosityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricCapacitanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricChargeMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricConductanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricCurrentMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricResistanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcElectricVoltageMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcEnergyMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFontStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFontVariant": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFontWeight": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcForceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcFrequencyMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcGloballyUniqueId": {
      "domain": "ifcutilityresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcHeatFluxDensityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcHeatingValueMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcIdentifier": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcIlluminanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcInductanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcInteger": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcIntegerCountRateMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcIonConcentrationMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcIsothermalMoistureCapacityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcKinematicViscosityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLabel": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLengthMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcBendingParameterSelect",
        "IfcMeasureValue",
        "IfcSizeSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLinearForceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLinearMomentMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLinearStiffnessMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue",
        "IfcTranslationalStiffnessSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLinearVelocityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLogical": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLuminousFluxMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLuminousIntensityDistributionMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLuminousIntensityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMagneticFluxDensityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMagneticFluxMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMassDensityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMassFlowRateMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMassMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMassPerLengthMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcModulusOfElasticityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcModulusOfLinearSubgradeReactionMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue",
        "IfcModulusOfTranslationalSubgradeReactionSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcModulusOfRotationalSubgradeReactionMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue",
        "IfcModulusOfRotationalSubgradeReactionSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcModulusOfSubgradeReactionMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue",
        "IfcModulusOfSubgradeReactionSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMoistureDiffusivityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMolecularWeightMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMomentOfInertiaMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMonetaryMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcMonthInYearNumber": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcNumericMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPHMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcParameterValue": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue",
        "IfcTrimmingSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPlanarForceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPlaneAngleMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcBendingParameterSelect",
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPowerMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPresentableText": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcPressureMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRadioActivityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRatioMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue",
        "IfcSizeSelect",
        "IfcTimeOrRatioSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcReal": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRotationalFrequencyMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRotationalMassMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcRotationalStiffnessMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue",
        "IfcRotationalStiffnessSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSectionModulusMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSectionalAreaIntegralMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcShearModulusMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSolidAngleMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSoundPowerLevelMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSoundPowerMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSoundPressureLevelMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSoundPressureMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpecificHeatCapacityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpecularExponent": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcSpecularHighlightSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcSpecularRoughness": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcSpecularHighlightSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTemperatureGradientMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTemperatureRateOfChangeMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcText": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTextAlignment": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTextDecoration": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTextFontName": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTextTransformation": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcThermalAdmittanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcThermalConductivityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcThermalExpansionCoefficientMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcThermalResistanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcThermalTransmittanceMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcThermodynamicTemperatureMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTime": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTimeMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTimeStamp": {
      "domain": "ifcdatetimeresource",
      "superclasses": [
        "IfcSimpleValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcTorqueMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcURIReference": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [],
      "fields": {
        "wrappedValue": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcVaporPermeabilityMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcVolumeMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcVolumetricFlowRateMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWarpingConstantMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcWarpingMomentMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue",
        "IfcWarpingStiffnessSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": false
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcBoxAlignment": {
      "domain": "ifcpresentationdefinitionresource",
      "superclasses": [
        "IfcLabel"
      ],
      "fields": {}
    },
    "IfcCompoundPlaneAngleMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcDerivedMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "int",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcLanguageId": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [
        "IfcIdentifier"
      ],
      "fields": {}
    },
    "IfcNonNegativeLengthMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcLengthMeasure",
        "IfcMeasureValue"
      ],
      "fields": {}
    },
    "IfcNormalisedRatioMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcRatioMeasure",
        "IfcColourOrFactor",
        "IfcMeasureValue",
        "IfcSizeSelect"
      ],
      "fields": {}
    },
    "IfcPositiveLengthMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcLengthMeasure",
        "IfcHatchLineDistanceSelect",
        "IfcMeasureValue",
        "IfcSizeSelect"
      ],
      "fields": {}
    },
    "IfcPositivePlaneAngleMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcPlaneAngleMeasure",
        "IfcMeasureValue"
      ],
      "fields": {}
    },
    "IfcPositiveRatioMeasure": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcRatioMeasure",
        "IfcMeasureValue",
        "IfcSizeSelect"
      ],
      "fields": {}
    },
    "IfcActionRequestTypeEnum": {},
    "IfcActionSourceTypeEnum": {},
    "IfcActionTypeEnum": {},
    "IfcActuatorTypeEnum": {},
    "IfcAddressTypeEnum": {},
    "IfcAirTerminalBoxTypeEnum": {},
    "IfcAirTerminalTypeEnum": {},
    "IfcAirToAirHeatRecoveryTypeEnum": {},
    "IfcAlarmTypeEnum": {},
    "IfcAnalysisModelTypeEnum": {},
    "IfcAnalysisTheoryTypeEnum": {},
    "IfcArithmeticOperatorEnum": {},
    "IfcAssemblyPlaceEnum": {},
    "IfcAudioVisualApplianceTypeEnum": {},
    "IfcBSplineCurveForm": {},
    "IfcBSplineSurfaceForm": {},
    "IfcBeamTypeEnum": {},
    "IfcBenchmarkEnum": {},
    "IfcBoilerTypeEnum": {},
    "IfcBooleanOperator": {},
    "IfcBuildingElementPartTypeEnum": {},
    "IfcBuildingElementProxyTypeEnum": {},
    "IfcBuildingSystemTypeEnum": {},
    "IfcBurnerTypeEnum": {},
    "IfcCableCarrierFittingTypeEnum": {},
    "IfcCableCarrierSegmentTypeEnum": {},
    "IfcCableFittingTypeEnum": {},
    "IfcCableSegmentTypeEnum": {},
    "IfcChangeActionEnum": {},
    "IfcChillerTypeEnum": {},
    "IfcChimneyTypeEnum": {},
    "IfcCoilTypeEnum": {},
    "IfcColumnTypeEnum": {},
    "IfcCommunicationsApplianceTypeEnum": {},
    "IfcComplexPropertyTemplateTypeEnum": {},
    "IfcCompressorTypeEnum": {},
    "IfcCondenserTypeEnum": {},
    "IfcConnectionTypeEnum": {},
    "IfcConstraintEnum": {},
    "IfcConstructionEquipmentResourceTypeEnum": {},
    "IfcConstructionMaterialResourceTypeEnum": {},
    "IfcConstructionProductResourceTypeEnum": {},
    "IfcControllerTypeEnum": {},
    "IfcCooledBeamTypeEnum": {},
    "IfcCoolingTowerTypeEnum": {},
    "IfcCostItemTypeEnum": {},
    "IfcCostScheduleTypeEnum": {},
    "IfcCoveringTypeEnum": {},
    "IfcCrewResourceTypeEnum": {},
    "IfcCurtainWallTypeEnum": {},
    "IfcCurveInterpolationEnum": {},
    "IfcDamperTypeEnum": {},
    "IfcDataOriginEnum": {},
    "IfcDerivedUnitEnum": {},
    "IfcDirectionSenseEnum": {},
    "IfcDiscreteAccessoryTypeEnum": {},
    "IfcDistributionChamberElementTypeEnum": {},
    "IfcDistributionPortTypeEnum": {},
    "IfcDistributionSystemEnum": {},
    "IfcDocumentConfidentialityEnum": {},
    "IfcDocumentStatusEnum": {},
    "IfcDoorPanelOperationEnum": {},
    "IfcDoorPanelPositionEnum": {},
    "IfcDoorStyleConstructionEnum": {},
    "IfcDoorStyleOperationEnum": {},
    "IfcDoorTypeEnum": {},
    "IfcDoorTypeOperationEnum": {},
    "IfcDuctFittingTypeEnum": {},
    "IfcDuctSegmentTypeEnum": {},
    "IfcDuctSilencerTypeEnum": {},
    "IfcElectricApplianceTypeEnum": {},
    "IfcElectricDistributionBoardTypeEnum": {},
    "IfcElectricFlowStorageDeviceTypeEnum": {},
    "IfcElectricGeneratorTypeEnum": {},
    "IfcElectricMotorTypeEnum": {},
    "IfcElectricTimeControlTypeEnum": {},
    "IfcElementAssemblyTypeEnum": {},
    "IfcElementCompositionEnum": {},
    "IfcEngineTypeEnum": {},
    "IfcEvaporativeCoolerTypeEnum": {},
    "IfcEvaporatorTypeEnum": {},
    "IfcEventTriggerTypeEnum": {},
    "IfcEventTypeEnum": {},
    "IfcExternalSpatialElementTypeEnum": {},
    "IfcFanTypeEnum": {},
    "IfcFastenerTypeEnum": {},
    "IfcFilterTypeEnum": {},
    "IfcFireSuppressionTerminalTypeEnum": {},
    "IfcFlowDirectionEnum": {},
    "IfcFlowInstrumentTypeEnum": {},
    "IfcFlowMeterTypeEnum": {},
    "IfcFootingTypeEnum": {},
    "IfcFurnitureTypeEnum": {},
    "IfcGeographicElementTypeEnum": {},
    "IfcGeometricProjectionEnum": {},
    "IfcGlobalOrLocalEnum": {},
    "IfcGridTypeEnum": {},
    "IfcHeatExchangerTypeEnum": {},
    "IfcHumidifierTypeEnum": {},
    "IfcInterceptorTypeEnum": {},
    "IfcInternalOrExternalEnum": {},
    "IfcInventoryTypeEnum": {},
    "IfcJunctionBoxTypeEnum": {},
    "IfcKnotType": {},
    "IfcLaborResourceTypeEnum": {},
    "IfcLampTypeEnum": {},
    "IfcLayerSetDirectionEnum": {},
    "IfcLightDistributionCurveEnum": {},
    "IfcLightEmissionSourceEnum": {},
    "IfcLightFixtureTypeEnum": {},
    "IfcLoadGroupTypeEnum": {},
    "IfcLogicalOperatorEnum": {},
    "IfcMechanicalFastenerTypeEnum": {},
    "IfcMedicalDeviceTypeEnum": {},
    "IfcMemberTypeEnum": {},
    "IfcMotorConnectionTypeEnum": {},
    "IfcNullStyleEnum": {},
    "IfcObjectTypeEnum": {},
    "IfcObjectiveEnum": {},
    "IfcOccupantTypeEnum": {},
    "IfcOpeningElementTypeEnum": {},
    "IfcOutletTypeEnum": {},
    "IfcPerformanceHistoryTypeEnum": {},
    "IfcPermeableCoveringOperationEnum": {},
    "IfcPermitTypeEnum": {},
    "IfcPhysicalOrVirtualEnum": {},
    "IfcPileConstructionEnum": {},
    "IfcPileTypeEnum": {},
    "IfcPipeFittingTypeEnum": {},
    "IfcPipeSegmentTypeEnum": {},
    "IfcPlateTypeEnum": {},
    "IfcProcedureTypeEnum": {},
    "IfcProfileTypeEnum": {},
    "IfcProjectOrderTypeEnum": {},
    "IfcProjectedOrTrueLengthEnum": {},
    "IfcProjectionElementTypeEnum": {},
    "IfcPropertySetTemplateTypeEnum": {},
    "IfcProtectiveDeviceTrippingUnitTypeEnum": {},
    "IfcProtectiveDeviceTypeEnum": {},
    "IfcPumpTypeEnum": {},
    "IfcRailingTypeEnum": {},
    "IfcRampFlightTypeEnum": {},
    "IfcRampTypeEnum": {},
    "IfcRecurrenceTypeEnum": {},
    "IfcReflectanceMethodEnum": {},
    "IfcReinforcingBarRoleEnum": {},
    "IfcReinforcingBarSurfaceEnum": {},
    "IfcReinforcingBarTypeEnum": {},
    "IfcReinforcingMeshTypeEnum": {},
    "IfcRoleEnum": {},
    "IfcRoofTypeEnum": {},
    "IfcSIPrefix": {},
    "IfcSIUnitName": {},
    "IfcSanitaryTerminalTypeEnum": {},
    "IfcSectionTypeEnum": {},
    "IfcSensorTypeEnum": {},
    "IfcSequenceEnum": {},
    "IfcShadingDeviceTypeEnum": {},
    "IfcSimplePropertyTemplateTypeEnum": {},
    "IfcSlabTypeEnum": {},
    "IfcSolarDeviceTypeEnum": {},
    "IfcSpaceHeaterTypeEnum": {},
    "IfcSpaceTypeEnum": {},
    "IfcSpatialZoneTypeEnum": {},
    "IfcStackTerminalTypeEnum": {},
    "IfcStairFlightTypeEnum": {},
    "IfcStairTypeEnum": {},
    "IfcStateEnum": {},
    "IfcStructuralCurveActivityTypeEnum": {},
    "IfcStructuralCurveMemberTypeEnum": {},
    "IfcStructuralSurfaceActivityTypeEnum": {},
    "IfcStructuralSurfaceMemberTypeEnum": {},
    "IfcSubContractResourceTypeEnum": {},
    "IfcSurfaceFeatureTypeEnum": {},
    "IfcSurfaceSide": {},
    "IfcSwitchingDeviceTypeEnum": {},
    "IfcSystemFurnitureElementTypeEnum": {},
    "IfcTankTypeEnum": {},
    "IfcTaskDurationEnum": {},
    "IfcTaskTypeEnum": {},
    "IfcTendonAnchorTypeEnum": {},
    "IfcTendonTypeEnum": {},
    "IfcTextPath": {},
    "IfcTimeSeriesDataTypeEnum": {},
    "IfcTransformerTypeEnum": {},
    "IfcTransitionCode": {},
    "IfcTransportElementTypeEnum": {},
    "IfcTrimmingPreference": {},
    "IfcTubeBundleTypeEnum": {},
    "IfcUnitEnum": {},
    "IfcUnitaryControlElementTypeEnum": {},
    "IfcUnitaryEquipmentTypeEnum": {},
    "IfcValveTypeEnum": {},
    "IfcVibrationIsolatorTypeEnum": {},
    "IfcVoidingFeatureTypeEnum": {},
    "IfcWallTypeEnum": {},
    "IfcWasteTerminalTypeEnum": {},
    "IfcWindowPanelOperationEnum": {},
    "IfcWindowPanelPositionEnum": {},
    "IfcWindowStyleConstructionEnum": {},
    "IfcWindowStyleOperationEnum": {},
    "IfcWindowTypeEnum": {},
    "IfcWindowTypePartitioningEnum": {},
    "IfcWorkCalendarTypeEnum": {},
    "IfcWorkPlanTypeEnum": {},
    "IfcWorkScheduleTypeEnum": {},
    "IfcComplexNumber": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcMeasureValue"
      ],
      "fields": {
        "wrappedValue": {
          "type": "double",
          "reference": false,
          "many": true
        },
        "wrappedValueAsString": {
          "type": "string",
          "reference": false,
          "many": true
        }
      }
    },
    "IfcNullStyle": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcPresentationStyleSelect"
      ],
      "fields": {
        "wrappedValue": {
          "type": "enum",
          "reference": false,
          "many": false
        }
      }
    },
    "IfcActorSelect": {
      "domain": "ifcactorresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcAppliedValueSelect": {
      "domain": "ifccostresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcAxis2Placement": {
      "domain": "ifcgeometryresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcBendingParameterSelect": {
      "domain": "ifcstructuralelementsdomain",
      "superclasses": [],
      "fields": {}
    },
    "IfcBooleanOperand": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcClassificationReferenceSelect": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcClassificationSelect": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcColour": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcFillStyleSelect"
      ],
      "fields": {}
    },
    "IfcColourOrFactor": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcCoordinateReferenceSystemSelect": {
      "domain": "ifcrepresentationresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcCsgSelect": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcCurveFontOrScaledCurveFontSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcCurveOnSurface": {
      "domain": "ifcgeometryresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcCurveOrEdgeCurve": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcCurveStyleFontSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [
        "IfcCurveFontOrScaledCurveFontSelect"
      ],
      "fields": {}
    },
    "IfcDefinitionSelect": {
      "domain": "ifckernel",
      "superclasses": [],
      "fields": {}
    },
    "IfcDerivedMeasureValue": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcValue"
      ],
      "fields": {}
    },
    "IfcDocumentSelect": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcFillStyleSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcGeometricSetSelect": {
      "domain": "ifcgeometricmodelresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcGridPlacementDirectionSelect": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcHatchLineDistanceSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcLayeredItem": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcLibrarySelect": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcLightDistributionDataSourceSelect": {
      "domain": "ifcpresentationorganizationresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcMaterialSelect": {
      "domain": "ifcmaterialresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcMeasureValue": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcValue"
      ],
      "fields": {}
    },
    "IfcMetricValueSelect": {
      "domain": "ifcconstraintresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcModulusOfRotationalSubgradeReactionSelect": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcModulusOfSubgradeReactionSelect": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcModulusOfTranslationalSubgradeReactionSelect": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcObjectReferenceSelect": {
      "domain": "ifcpropertyresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcPointOrVertexPoint": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcPresentationStyleSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcProcessSelect": {
      "domain": "ifckernel",
      "superclasses": [],
      "fields": {}
    },
    "IfcProductRepresentationSelect": {
      "domain": "ifcrepresentationresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcProductSelect": {
      "domain": "ifckernel",
      "superclasses": [],
      "fields": {}
    },
    "IfcPropertySetDefinitionSelect": {
      "domain": "ifckernel",
      "superclasses": [],
      "fields": {}
    },
    "IfcResourceObjectSelect": {
      "domain": "ifcexternalreferenceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcResourceSelect": {
      "domain": "ifckernel",
      "superclasses": [],
      "fields": {}
    },
    "IfcRotationalStiffnessSelect": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcShell": {
      "domain": "ifctopologyresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcSimpleValue": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcValue"
      ],
      "fields": {}
    },
    "IfcSizeSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcSolidOrShell": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcSpaceBoundarySelect": {
      "domain": "ifcproductextension",
      "superclasses": [],
      "fields": {}
    },
    "IfcSpecularHighlightSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcStructuralActivityAssignmentSelect": {
      "domain": "ifcstructuralanalysisdomain",
      "superclasses": [],
      "fields": {}
    },
    "IfcStyleAssignmentSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcSurfaceOrFaceSurface": {
      "domain": "ifcgeometricconstraintresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcSurfaceStyleElementSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcTextFontSelect": {
      "domain": "ifcpresentationappearanceresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcTimeOrRatioSelect": {
      "domain": "ifcdatetimeresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcTranslationalStiffnessSelect": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcTrimmingSelect": {
      "domain": "ifcgeometryresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcUnit": {
      "domain": "ifcmeasureresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcValue": {
      "domain": "ifcmeasureresource",
      "superclasses": [
        "IfcAppliedValueSelect",
        "IfcMetricValueSelect"
      ],
      "fields": {}
    },
    "IfcVectorOrDirection": {
      "domain": "ifcgeometryresource",
      "superclasses": [],
      "fields": {}
    },
    "IfcWarpingStiffnessSelect": {
      "domain": "ifcstructuralloadresource",
      "superclasses": [],
      "fields": {}
    }
  }
}
});
define(["bimserverapi_BimServerApiPromise"], function(BimServerPromise){
	return function(bimServerApi, poid, roid, schema) {
		var othis = this;
		othis.schema = schema;
		othis.bimServerApi = bimServerApi;
		othis.poid = poid;
		othis.roid = roid;
		othis.waiters = [];

		othis.objects = {};
		othis.objectsByGuid = {};
		othis.objectsByName = {};

		othis.oidsFetching = {};
		othis.guidsFetching = {};
		othis.namesFetching = {};

		// Those are only fully loaded types (all of them), should not be stored here if loaded partially
		othis.loadedTypes = [];
		othis.loadedDeep = false;
		othis.changedObjectOids = {};
		othis.loading = false;
		othis.logging = true;
		
		othis.changes = 0;
		othis.changeListeners = [];
		
		this.init = function(callback){
			callback();
		};
		
		this.load = function(deep, modelLoadCallback) {
			if (deep) {
				othis.loading = true;
				othis.bimServerApi.getJsonSerializer(function(serializer){
					bimServerApi.call("Bimsie1ServiceInterface", "download", {
						roid: othis.roid,
						serializerOid: serializer.oid,
						showOwn: true,
						sync: true
					}, function(topicId){
						var url = bimServerApi.generateRevisionDownloadUrl({
							topicId: topicId,
							serializerOid: serializer.oid
						});
						othis.bimServerApi.getJson(url, null, function(data){
							data.objects.forEach(function(object){
								othis.objects[object._i] = othis.createWrapper(object, object._t);
							});
							othis.loading = false;
							othis.loadedDeep = true;
							othis.waiters.forEach(function(waiter){
								waiter();
							});
							othis.waiters = [];
							bimServerApi.call("ServiceInterface", "cleanupLongAction", {topicId: topicId}, function(){
								if (modelLoadCallback != null) {
									modelLoadCallback(othis);
								}
							});
						}, function(error){
							console.log(error);
						});
					});
				});
			} else {
				othis.loaded = true;
				if (modelLoadCallback != null) {
					modelLoadCallback(othis);
				}
			}
		};
		
		// Start a transaction, make sure to wait for the callback to be called, only after that the transaction will be active
		this.startTransaction = function(callback){
			bimServerApi.call("Bimsie1LowLevelInterface", "startTransaction", {poid: othis.poid}, function(tid){
				othis.tid = tid;
				callback(tid);
			});
		};

		// Checks whether a transaction is running, if not, it throws an exception, otherwise it return the tid
		this.checkTransaction = function(){
			if (othis.tid != null) {
				return othis.tid;
			}
			throw Exception("No transaction is running, call startTransaction first");
		};
		
		this.create = function(className, object, callback) {
			var tid = othis.checkTransaction();
			object._t = className;
			var wrapper = othis.createWrapper({}, className);
			bimServerApi.call("Bimsie1LowLevelInterface", "createObject", {tid: tid, className: className}, function(oid){
				wrapper._i = oid;
				othis.objects[object._i] = wrapper;
				object._s = 1;
				if (callback != null) {
					callback(object);
				}
			});
			return object;
		};

		this.waitForLoaded = function(callback) {
			if (othis.loaded) {
				callback();
			} else {
				othis.waiters.push(callback);
			}
		};
		
		this.reset = function(){
			
		};

		this.commit = function(comment, callback){
			var tid = othis.checkTransaction();
			bimServerApi.call("Bimsie1LowLevelInterface", "commitTransaction", {tid: tid, comment: comment}, function(roid){
				if (callback != null) {
					callback(roid);
				}
			});
		};
		
		this.abort = function(callback){
			var tid = othis.checkTransaction();
			bimServerApi.call("Bimsie1LowLevelInterface", "abortTransaction", {tid: tid}, function(roid){
				if (callback != null) {
					callback();
				}
			});
		};
		
		this.addChangeListener = function(changeListener){
			othis.changeListeners.push(changeListener);
		};

		this.incrementChanges = function(){
			othis.changes++;
			othis.changeListeners.forEach(function(changeListener){
				changeListener(othis.changes);
			});
		};

		this.extendClass = function(wrapperClass, typeName){
			var realType = othis.bimServerApi.schemas[othis.schema][typeName];
			realType.superclasses.forEach(function(typeName){
				othis.extendClass(wrapperClass, typeName);
			});
			for (var fieldName in realType.fields){
				var field = realType.fields[fieldName];
				(function(field, fieldName){
					if (field.reference) {
						wrapperClass["set" + fieldName.firstUpper() + "Wrapped"] = function(typeName, value) {
							var object = this.object;
							object[fieldName] = {_t: typeName, value: value};
							var tid = othis.checkTransaction();
							var type = othis.bimServerApi.schemas[othis.schema][typeName];
							var wrappedValueType = type.fields.wrappedValue;
							if (wrappedValueType.type == "string") {
								bimServerApi.call("Bimsie1LowLevelInterface", "setWrappedStringAttribute", {
									tid: tid,
									oid: object._i,
									attributeName: fieldName,
									type: typeName,
									value: value
								}, function(){
									if (object.changedFields == null) {
										object.changedFields = {};
									}
									object.changedFields[fieldName] = true;
									othis.changedObjectOids[object.oid] = true;
									othis.incrementChanges();
								});
							}
						};
						wrapperClass["set" + fieldName.firstUpper()] = function(value) {
							var tid = othis.checkTransaction();
							var object = this.object;
							object[fieldName] = value;
							if (value == null) {
								bimServerApi.call("Bimsie1LowLevelInterface", "unsetReference", {
									tid: tid,
									oid: object._i,
									referenceName: fieldName,
								}, function(){
									if (object.changedFields == null) {
										object.changedFields = {};
									}
									object.changedFields[fieldName] = true;
									othis.changedObjectOids[object.oid] = true;
								});
							} else {
								bimServerApi.call("Bimsie1LowLevelInterface", "setReference", {
									tid: tid,
									oid: object._i,
									referenceName: fieldName,
									referenceOid: value._i
								}, function(){
									if (object.changedFields == null) {
										object.changedFields = {};
									}
									object.changedFields[fieldName] = true;
									othis.changedObjectOids[object.oid] = true;
								});
							}
						};
						wrapperClass["add" + fieldName.firstUpper()] = function(value, callback) {
							var object = this.object;
							var tid = othis.checkTransaction();
							if (object[fieldName] == null) {
								object[fieldName] = [];
							}
							object[fieldName].push(value);
							bimServerApi.call("Bimsie1LowLevelInterface", "addReference", {
								tid: tid,
								oid: object._i,
								referenceName: fieldName,
								referenceOid: value._i
							}, function(){
								if (object.changedFields == null) {
									object.changedFields = {};
								}
								object.changedFields[fieldName] = true;
								othis.changedObjectOids[object.oid] = true;
								if (callback != null) {
									callback();
								}
							});
						};
						wrapperClass["remove" + fieldName.firstUpper()] = function(value, callback) {
							var object = this.object;
							var tid = othis.checkTransaction();
							var list = object[fieldName];
							var index = list.indexOf(value);
							list.splice(index, 1);
							
							bimServerApi.call("Bimsie1LowLevelInterface", "removeReference", {
								tid: tid,
								oid: object._i,
								referenceName: fieldName,
								index: index
							}, function(){
								if (object.changedFields == null) {
									object.changedFields = {};
								}
								object.changedFields[fieldName] = true;
								othis.changedObjectOids[object.oid] = true;
								if (callback != null) {
									callback();
								}
							});
						};
						wrapperClass["get" + fieldName.firstUpper()] = function(callback) {
							var object = this.object;
							var model = this.model;
							var promise = new BimServerPromise();
							if (object[fieldName] != null) {
								if (field.many) {
									object[fieldName].forEach(function(item){
										callback(item);
									});
								} else {
									callback(object[fieldName]);
								}							
								promise.fire();
								return promise;
							}
							var embValue = object["_e" + fieldName];
							if (embValue != null) {
								callback(embValue);
								promise.fire();
								return promise;
							}
							var value = object["_r" + fieldName];
							if (field.many) {
								if (object[fieldName] == null) {
									object[fieldName] = [];
								}
								if (value != null) {
									model.get(value, function(v){
										object[fieldName].push(v);
										callback(v);
									}).done(function(){
										promise.fire();
									});
								} else {
									promise.fire();
								}
							} else {
								if (value != null) {
									var ref = othis.objects[value];
									if (value == -1) {
										callback(null);
										promise.fire();
									} else if (ref == null || ref.object._s == 0) {
										model.get(value, function(v){
											object[fieldName] = v;
											callback(v);
										}).done(function(){
											promise.fire();
										});
									} else {
										object[fieldName] = ref;
										callback(ref);
										promise.fire();
									}
								} else {
									callback(null);
									promise.fire();
								}
							}
							return promise;
						};
					} else {
						wrapperClass["get" + fieldName.firstUpper()] = function(callback) {
							var object = this.object;
							if (field.many) {
								if (object[fieldName] == null) {
									object[fieldName] = [];
								}
								object[fieldName].push = function(val){
								};
							}
							if (callback != null) {
								callback(object[fieldName]);
							}
							return object[fieldName];
						};
						wrapperClass["set" + fieldName.firstUpper()] = function(value) {
							var object = this.object;
							object[fieldName] = value;
							var tid = othis.checkTransaction();
							if (field.many) {
								bimServerApi.call("Bimsie1LowLevelInterface", "setDoubleAttributes", {
									tid: tid,
									oid: object._i,
									attributeName: fieldName,
									values: value
								}, function(){
								});
							} else {
								if (value == null) {
									bimServerApi.call("Bimsie1LowLevelInterface", "unsetAttribute", {
										tid: tid,
										oid: object._i,
										attributeName: fieldName
									}, function(){
									});
								} else if (field.type == "string") {
									bimServerApi.call("Bimsie1LowLevelInterface", "setStringAttribute", {
										tid: tid,
										oid: object._i,
										attributeName: fieldName,
										value: value
									}, function(){
									});
								} else if (field.type == "double") {
									bimServerApi.call("Bimsie1LowLevelInterface", "setDoubleAttribute", {
										tid: tid,
										oid: object._i,
										attributeName: fieldName,
										value: value
									}, function(){
									});
								} else if (field.type == "boolean") {
									bimServerApi.call("Bimsie1LowLevelInterface", "setBooleanAttribute", {
										tid: tid,
										oid: object._i,
										attributeName: fieldName,
										value: value
									}, function(){
									});
								} else if (field.type == "int") {
									bimServerApi.call("Bimsie1LowLevelInterface", "setIntegerAttribute", {
										tid: tid,
										oid: object._i,
										attributeName: fieldName,
										value: value
									}, function(){
									});
								} else if (field.type == "enum") {
									bimServerApi.call("Bimsie1LowLevelInterface", "setEnumAttribute", {
										tid: tid,
										oid: object._i,
										attributeName: fieldName,
										value: value
									}, function(){
									});
								} else {
									othis.bimServerApi.log("Unimplemented type " + typeof value);
								}
								object[fieldName] = value;
							}
							if (object.changedFields == null) {
								object.changedFields = {};
							}
							object.changedFields[fieldName] = true;
							othis.changedObjectOids[object.oid] = true;
						};
					}
				})(field, fieldName);
			}
		};
		
		this.dumpByType = function(){
			var mapLoaded = {};
			var mapNotLoaded = {};
			for (var oid in othis.objects) {
				var object = othis.objects[oid];
				var type = object.getType();
				var counter = mapLoaded[type];
				if (object.object._s == 1) {
					if (counter == null) {
						mapLoaded[type] = 1;
					} else {
						mapLoaded[type] = counter + 1;
					}
				}
				if (object.object._s == 0) {
					var counter = mapNotLoaded[type];
					if (counter == null) {
						mapNotLoaded[type] = 1;
					} else {
						mapNotLoaded[type] = counter + 1;
					}
				}
			}
			console.log("LOADED");
			for (var type in mapLoaded) {
				console.log(type, mapLoaded[type]);
			}
			console.log("NOT_LOADED");
			for (var type in mapNotLoaded) {
				console.log(type, mapNotLoaded[type]);
			}
		};
		
		this.getClass = function(typeName){
			if (othis.bimServerApi.classes[typeName] == null) {
				var realType = othis.bimServerApi.schemas[othis.schema][typeName];
				if (realType == null) {
					if (typeName == "GeometryInfo") {
						return null;
					}
					throw "Type " + typeName + " not found in schema " + othis.schema;
				}

				var wrapperClass = {};
				
				wrapperClass.isA = function(typeName){
					return othis.bimServerApi.isA(othis.schema, this.object._t, typeName);
				};
				wrapperClass.getType = function(){
					return this.object._t;
				};
				wrapperClass.remove = function(removeCallback){
					var tid = othis.checkTransaction();
					bimServerApi.call("Bimsie1LowLevelInterface", "removeObject", {tid: tid, oid: this.object._i}, function(){
						if (removeCallback != null) {
							removeCallback();
						}
						delete othis.objects[this.object._i];
					});
				};
				
				othis.extendClass(wrapperClass, typeName);

				othis.bimServerApi.classes[typeName] = wrapperClass;
			}
			return othis.bimServerApi.classes[typeName];
		};
		
		this.createWrapper = function(object, typeName) {
			if (othis.objects[object._i] != null) {
				console.log("Warning!", object);
			}
			if (typeName == null) {
				console.warn("typeName = null", object);
			}
			object.oid = object._i;
			var cl = othis.getClass(typeName);
			var wrapper = Object.create(cl);
			// transient variables
			wrapper.trans = {
				mode: 2
			};
			wrapper.oid = object.oid;
			wrapper.model = othis;
			wrapper.object = object;
			return wrapper;
		};

		this.size = function(callback){
			bimServerApi.call("Bimsie1ServiceInterface", "getRevision", {roid: roid}, function(revision){
				callback(revision.size);
			});
		};

		this.count = function(type, includeAllSubTypes, callback) {
			// TODO use includeAllSubTypes
			bimServerApi.call("Bimsie1LowLevelInterface", "count", {roid: roid, className: type}, function(size){
				callback(size);
			});
		};

		this.getByX = function(methodName, keyname, fetchingMap, targetMap, interfaceMethodName, interfaceFieldName, getValueMethod, list, callback) {
			var promise = new BimServerPromise();
			if (typeof list == "string" || typeof list == "number") {
				list = [list];
			}
			othis.waitForLoaded(function(){
				var len = list.length;
				// Iterating in reverse order because we remove items from this array
				while (len--) {
					var item = list[len];
					if (targetMap[item] != null) {
						// Already loaded? Remove from list and call callback
						var existingObject = targetMap[item].object;
						if (existingObject._s == 1) {
							var index = list.indexOf(item);
							list.splice(index, 1);
							callback(targetMap[item]);
						}
					} else if (fetchingMap[item] != null) {
						// Already loading? Add the callback to the list and remove from fetching list
						fetchingMap[item].push(callback);
						var index = list.indexOf(item);
						list.splice(index, 1);
					}
				}
				// Any left?
				if (list.length > 0) {
					list.forEach(function(item){
						fetchingMap[item] = [];
					});
					othis.bimServerApi.getJsonSerializer(function(serializer){
						var request = {
							roids: [othis.roid],
							serializerOid: serializer.oid,
							deep: false,
							sync: true
						};
						request[interfaceFieldName] = list;
						bimServerApi.call("Bimsie1ServiceInterface", interfaceMethodName, request, function(topicId){
							var url = bimServerApi.generateRevisionDownloadUrl({
								topicId: topicId,
								serializerOid: serializer.oid
							});
							othis.bimServerApi.getJson(url, null, function(data){
								if (data.objects.length > 0) {
									var done = 0;
									data.objects.forEach(function(object){
										var wrapper = null;
										if (othis.objects[object._i] != null) {
											wrapper = othis.objects[object._i];
											if (wrapper.object._s != 1) {
												wrapper.object = object;
											}											
										} else {
											wrapper = othis.createWrapper(object, object._t);
										}
										var item = getValueMethod(object);
										// Checking the value again, because sometimes serializers send more objects...
										if (list.indexOf(item) != -1) {
											targetMap[item] = wrapper;
											if (fetchingMap[item] != null) {
												fetchingMap[item].forEach(function(cb){
													cb(wrapper);
												});
												delete fetchingMap[item];
											}
											callback(wrapper);
										}
										done++;
										if (done == data.objects.length) {
											bimServerApi.call("ServiceInterface", "cleanupLongAction", {topicId: topicId}, function(){
												promise.fire();
											});
										}
									});
								} else {
									othis.bimServerApi.log("Object with " + keyname + " " + list + " not found");
									callback(null);
									promise.fire();
								}
							}, function(error){
								console.log(error);
							});
						});
					});
				} else {
					promise.fire();
				}
			});
			return promise;
		};

		this.getByGuids = function(guids, callback) {
			return othis.getByX("getByGuid", "guid", othis.guidsFetching, othis.objectsByGuid, "downloadByGuids", "guids", function(object){return object.GlobalId}, guids, callback);
		};

		this.get = function(oids, callback) {
			return othis.getByX("get", "OID", othis.oidsFetching, othis.objects, "downloadByOids", "oids", function(object){return object._i}, oids, callback);
		};

		this.getByName = function(names, callback) {
			return othis.getByX("getByName", "name", othis.namesFetching, othis.objectsByName, "downloadByNames", "names", function(object){return object.getName == null ? null : object.getName()}, names, callback);
		};

		this.query = function(query, callback){
			var promise = new BimServerPromise();
			var fullTypesLoading = {};
			query.queries.forEach(function(subQuery){
				if (subQuery.type != null) {
					fullTypesLoading[subQuery.type] = true;
					othis.loadedTypes[subQuery.type] = {};
					if (subQuery.includeAllSubTypes) {
						var schema = othis.bimServerApi.schemas[othis.schema];
						othis.bimServerApi.getAllSubTypes(schema, subQuery.type, function(subTypeName){
							fullTypesLoading[subTypeName] = true;
							othis.loadedTypes[subTypeName] = {};
						});
					}
				}
			});
			othis.waitForLoaded(function(){
				othis.bimServerApi.getJsonSerializer(function(serializer){
					bimServerApi.callWithFullIndication("Bimsie1ServiceInterface", "downloadByJsonQuery", {
						roids: [othis.roid],
						jsonQuery: JSON.stringify(query),
						serializerOid: serializer.oid,
						sync: true
					}, function(topicId){
						var url = bimServerApi.generateRevisionDownloadUrl({
							topicId: topicId,
							serializerOid: serializer.oid
						});
						othis.bimServerApi.notifier.setInfo("Getting model data...", -1);
						othis.bimServerApi.getJson(url, null, function(data){
//							console.log("query", data.objects.length);
							data.objects.forEach(function(object){
								var wrapper = othis.objects[object._i];
								if (wrapper == null) {
									wrapper = othis.createWrapper(object, object._t);
									othis.objects[object._i] = wrapper;
									if (fullTypesLoading[object._t] != null) {
										othis.loadedTypes[object._t][wrapper.oid] = wrapper;
									}
								} else {
									if (object._s == 1) {
										wrapper.object = object;
									}
								}
//								if (othis.loadedTypes[wrapper.getType()] == null) {
//									othis.loadedTypes[wrapper.getType()] = {};
//								}
//								othis.loadedTypes[wrapper.getType()][object._i] = wrapper;
								if (object._s == 1) {
									callback(wrapper);
								}
							});
//							othis.dumpByType();
							bimServerApi.call("ServiceInterface", "cleanupLongAction", {topicId: topicId}, function(){
								promise.fire();
								othis.bimServerApi.notifier.setSuccess("Model data successfully downloaded...");
							});
						}, function(error){
							console.log(error);
						});
					});
				});
			});
			return promise;
		};

		this.queryNew = function(query, callback){
			var promise = new BimServerPromise();
			var fullTypesLoading = {};
			if (query.queries != null) {
				query.queries.forEach(function(subQuery){
					if (subQuery.type != null) {
						fullTypesLoading[subQuery.type] = true;
						othis.loadedTypes[subQuery.type] = {};
						if (subQuery.includeAllSubtypes) {
							var schema = othis.bimServerApi.schemas[othis.schema];
							othis.bimServerApi.getAllSubTypes(schema, subQuery.type, function(subTypeName){
								fullTypesLoading[subTypeName] = true;
								othis.loadedTypes[subTypeName] = {};
							});
						}
					}
				});
			}
			othis.waitForLoaded(function(){
				othis.bimServerApi.getJsonStreamingSerializer(function(serializer){
					bimServerApi.callWithFullIndication("Bimsie1ServiceInterface", "downloadByNewJsonQuery", {
						roids: [othis.roid],
						query: JSON.stringify(query),
						serializerOid: serializer.oid,
						sync: false
					}, function(topicId){
						var handled = false;
						othis.bimServerApi.registerProgressHandler(topicId, function(topicId, state){
							if (state.title == "Done preparing" && !handled) {
								handled = true;
								var url = bimServerApi.generateRevisionDownloadUrl({
									topicId: topicId,
									serializerOid: serializer.oid
								});
								othis.bimServerApi.notifier.setInfo("Getting model data...", -1);
								othis.bimServerApi.getJson(url, null, function(data){
//									console.log("query", data.objects.length);
									data.objects.forEach(function(object){
										var wrapper = othis.objects[object._i];
										if (wrapper == null) {
											wrapper = othis.createWrapper(object, object._t);
											othis.objects[object._i] = wrapper;
											if (fullTypesLoading[object._t] != null) {
												othis.loadedTypes[object._t][wrapper.oid] = wrapper;
											}
										} else {
											if (object._s == 1) {
												wrapper.object = object;
											}
										}
//										if (othis.loadedTypes[wrapper.getType()] == null) {
//											othis.loadedTypes[wrapper.getType()] = {};
//										}
//										othis.loadedTypes[wrapper.getType()][object._i] = wrapper;
										if (object._s == 1) {
											callback(wrapper);
										}
									});
//									othis.dumpByType();
									bimServerApi.call("ServiceInterface", "cleanupLongAction", {topicId: topicId}, function(){
										promise.fire();
										othis.bimServerApi.notifier.setSuccess("Model data successfully downloaded...");
									});
								});								
							}
						});
					});
				});
			});
			return promise;
		};
		
		this.getAllOfType = function(type, includeAllSubTypes, callback) {
			var promise = new BimServerPromise();
			othis.waitForLoaded(function(){
				if (othis.loadedDeep) {
					for (var oid in othis.objects) {
						var object = othis.objects[oid];
						if (object._t == type) {
							callback(object);
						}
					}
					promise.fire();
				} else {
					var types = [];
					types.push(type);
					if (includeAllSubTypes) {
						othis.bimServerApi.getAllSubTypes(othis.bimServerApi.schemas[othis.schema], type, function(subType){
							types.push(subType);	
						});
					}
					
					var typesToLoad = [];
					
					types.forEach(function(type){
						if (othis.loadedTypes[type] != null) {
							for (var oid in othis.loadedTypes[type]) {
								callback(othis.loadedTypes[type][oid]);
							}
						} else {
							typesToLoad.push(type);
						}
					});

					if (typesToLoad.length > 0) {
						othis.bimServerApi.getJsonSerializer(function(serializer){
							bimServerApi.call("Bimsie1ServiceInterface", "downloadByTypes", {
								roids: [othis.roid],
								classNames: typesToLoad,
								schema: othis.schema,
								includeAllSubtypes: false,
								serializerOid: serializer.oid,
								useObjectIDM: false,
								deep: false,
								sync: true
							}, function(topicId){
								var url = bimServerApi.generateRevisionDownloadUrl({
									topicId: topicId,
									serializerOid: serializer.oid
								});
								othis.bimServerApi.getJson(url, null, function(data){
									if (othis.loadedTypes[type] == null) {
										othis.loadedTypes[type] = {};
									}
									data.objects.forEach(function(object){
										if (othis.objects[object._i] != null) {
											// Hmm we are doing a query on type, but some objects have already loaded, let's use those instead
											var wrapper = othis.objects[object._i];
											if (wrapper.object._s == 1) {
												if (wrapper.isA(type)) {
													othis.loadedTypes[type][object._i] = wrapper;
													callback(wrapper);
												}
											} else {
												// Replace the value with something that's LOADED
												wrapper.object = object;
												if (wrapper.isA(type)) {
													othis.loadedTypes[type][object._i] = wrapper;
													callback(wrapper);
												}
											}
										} else {
											var wrapper = othis.createWrapper(object, object._t);
											othis.objects[object._i] = wrapper;
											if (wrapper.isA(type) && object._s == 1) {
												othis.loadedTypes[type][object._i] = wrapper;
												callback(wrapper);
											}
										}
									});
									bimServerApi.call("ServiceInterface", "cleanupLongAction", {topicId: topicId}, function(){
										promise.fire();
									});
								}, function(error){
									console.log(error);
								});
							});
						});					
					} else {
						promise.fire();
					}
				}
			});
			return promise;
		};
	}
});
define(function(){
	return {
		GETDATAOBJECTSBYTYPE_BUSY: "Loading objects",
		REQUESTPASSWORDCHANGE_BUSY: "Busy sending password reset e-mail",
		REQUESTPASSWORDCHANGE_DONE: "A password reset e-mail has been sent",
		SETSERVERSETTINGS_DONE: "Server settings successfully updated",
		ENABLEPLUGIN_DONE: "Plugin successfully enabled",
		DISABLEPLUGIN_DONE: "Plugin successfully disabled",
		SETDEFAULTWEBMODULE_DONE: "Default webmodule changed",
		SETDEFAULTQUERYENGINE_DONE: "Default Query Engine successfully changed",
		SETDEFAULTMODELMERGER_DONE: "Default Model Merger successfully changed",
		SETDEFAULTSERIALIZER_DONE: "Default Serializer successfully changed",
		SETDEFAULTOBJECTIDM_DONE: "Default ObjectIDM successfully changed",
		SETDEFAULTRENDERENGINE_DONE: "Default Render Engine successfully changed",
		SETDEFAULTMODELCOMPARE_DONE: "Default Model Compare successfully changed",
		LOGIN_BUSY: "Trying to login",
		CHANGEUSERTYPE_DONE: "Type of user successfully changed",
		ADDUSER_DONE: "User successfully added, you should receive a validation email shortly",
		UPDATEINTERNALSERVICE_DONE: "Internal service successfully updated",
		UPDATEMODELCOMPARE_DONE: "Model compare plugin successfully updated",
		UPDATEMODELMERGER_DONE: "Model merger successfully updated",
		UPDATEQUERYENGINE_DONE: "Query engine plugin successfully updated",
		UPDATEOBJECTIDM_DONE: "ObjectIDM succesfully updated",
		UPDATEDESERIALIZER_DONE: "Serializer succesfully updated",
		ADDUSERTOPROJECT_DONE: "User successfully added to project",
		REMOVEUSERFROMPROJECT_DONE: "User successfully removed from project",
		UNDELETEPROJECT_DONE: "Project successfully undeleted",
		DELETEPROJECT_DONE: "Project successfully deleted",
		ADDPROJECT_DONE: "Project successfully added",
		DOWNLOAD_BUSY: "Busy downloading...",
		VALIDATEACCOUNT_DONE: "Account successfully validated, you can now login",
		ADDPROJECTASSUBPROJECT_DONE: "Sub project added successfully",
		DOWNLOADBYJSONQUERY_BUSY: "Downloading BIM",
		CHECKINFROMURL_DONE: "Done checking in from URL",
		GETLOGGEDINUSER_BUSY: "Getting user details",
		SETPLUGINSETTINGS_DONE: "Plugin settings successfully saved",
		GETSERVERINFO_BUSY: "Getting server info",
		GETVERSION_BUSY: "Getting server version",
		GETPROJECTBYPOID_BUSY: "Getting project details",
		GETALLRELATEDPROJECTS_BUSY: "Getting related project's details",
		GETSERIALIZERBYPLUGINCLASSNAME_BUSY: "Getting serializer info",
		CLEANUPLONGACTION_BUSY: "Cleaning up",
		GETREVISIONSUMMARY_BUSY: "Getting revision summary",
		DOWNLOADBYOIDS_BUSY: "Downloading model data",
		REGISTERPROGRESSHANDLER_BUSY: "Registering for updates on progress",
		GETALLREVISIONSOFPROJECT_BUSY: "Getting all revisions of project",
		GETPLUGINDESCRIPTOR_BUSY: "Getting plugin information",
		GETUSERSETTINGS_BUSY: "Getting user settings",
		GETALLQUERYENGINES_BUSY: "Getting query engines",
		REGISTERNEWPROJECTHANDLER_BUSY: "Registering for updates on new projects",
		ADDUSER_BUSY: "Adding user..."
	}
});