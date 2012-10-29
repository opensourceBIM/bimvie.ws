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

function formatTrigger(trigger) {
	if (trigger == "NEW_REVISION") {
		return "New revision";
	}	
}