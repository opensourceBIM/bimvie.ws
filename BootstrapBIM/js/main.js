"use strict";
var pushing = false;

$.ajaxSetup({
	cache: false
})

function loadGeneric(targetElement, oidField, displayField, methodName, objectField, paramFunction) {
	var oid = targetElement.attr(oidField);
	if (objectcache[oid] != null) {
		if (objectcache[oid] instanceof Array) {
			objectcache[oid].push(targetElement);
		} else {
			targetElement.html(objectcache[oid][displayField]);
			targetElement.data(objectField, objectcache[oid]);
		}
	} else {
		objectcache[oid] = [targetElement];
		bimServerApi.call("ServiceInterface", methodName, paramFunction(oid), function(data){
			if (objectcache[oid] instanceof Array) {
				for(var i in objectcache[oid]) {
					var target = objectcache[oid][i];
					target.html(data[displayField]);
					target.data(objectField, data);
				}
				objectcache[oid] = data;
			} else {
				targetElement.html(data[displayField]);
				targetElement.data(objectField, data);
			}
		});
	}
}

Math.clamp = function(s, min, max) {
    return Math.min(Math.max(s, min), max);
  };

var  __indexOf = Array.prototype.indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i; } return -1; };

RegExp.escape = function(str) {
  return str.replace(/[[\]\\$().{},?*+|^-]/g, "\\$&");
};

function pushHistory(obj) {
	var current = History.getState();
	pushing = true;
	var str = "?";
	for (var i in obj) {
		str += i + "=" + obj[i] + "&";
	}
	if (str.endsWith("&")) {
		str = str.substring(0, str.length - 1);
	}
	History.pushState(obj, null, str);
	pushing = false;
}

function pushInitialState() {
	var loc = new String(document.location);
	if (loc.indexOf("?") != -1) {
		var obj = {};
		loc = loc.substring(loc.indexOf("?") + 1);
		var splitted = loc.split("&");
		for (var i in splitted) {
			var s = splitted[i];
			obj[s.substring(0, s.indexOf("="))] = s.substring(s.indexOf("=") + 1);
		}
		pushHistory(obj);
	}
}

function loadService(targetElement) {
	loadGeneric(targetElement, "soid", "name", "getService", "service", function(oid){return{soid: oid};});
}

function loadUser(targetElement) {
	loadGeneric(targetElement, "uoid", "name", "getUserByUoid", "user", function(oid){return{uoid: oid};});
}

function loadExtendedDataSchema(targetElement) {
	loadGeneric(targetElement, "soid", "name", "getExtendedDataSchemaById", "extendeddataschema", function(oid){return{oid: oid};});
}

function loadProject(targetElement) {
	loadGeneric(targetElement, "poid", "name", "getProjectByPoid", "project", function(oid){return{poid: oid};});
}

function newDropdown(title) {
	var div = $("<div class=\"btn-group\">");
	var a = $("<a class=\"btn dropdown-toggle\" data-toggle=\"dropdown\">");
	a.append(title);
	var span = $("<span class=\"caret\"></span>");
	a.append(span);
	div.append(a);
	var ul = $("<ul class=\"dropdown-menu\">");
	div.append(ul);
	return div;
}

function newSplitDropdown(title, clickCallback) {
	var div = $("<div class=\"btn-group\">");
	var button1 = $("<button class=\"btn btnMain\">" + title + "</button>");
	button1.click(clickCallback);
	div.append(button1);
	var button2 = $("<button class=\"btn dropdown-toggle\" data-toggle=\"dropdown\">");
	button2.append("<span class=\"caret\"></span>");
	div.append(button2);
	var ul = $("<ul class=\"dropdown-menu\">");
	div.append(ul);
	return div;
}

function newButton(title, click) {
	var button = $("<button class=\"btn\">" + title + "</button>");
	button.click(click);
	return button;
}

function newButtonTd(title, click) {
	var td = $("<td>");
	td.append(newButton(title, click));
	return td;
}

function newSplitDropDownTd(title, clickCallback) {
	var td = $("<td>");
	td.append(newSplitDropdown(title, clickCallback));
	return td;
}

function newDropdownTd(title) {
	var td = $("<td>");
	td.append(newDropdown(title));
	return td;
}

// http://stackoverflow.com/questions/4498866/actual-numbers-to-the-human-readable-values/4506030#4506030 //
var SizePrefixes = ' KMGTPEZYXWVU';

function getHumanSize(size) {
	if(size <= 0) return '0';
	var t2 = Math.min(Math.round(Math.log(size)/Math.log(1024)), 12);
	return (Math.round(size * 100 / Math.pow(1024, t2)) / 100) + SizePrefixes.charAt(t2).replace(' ', '') + 'B';
}
//http://stackoverflow.com/questions/4498866/actual-numbers-to-the-human-readable-values/4506030#4506030 //