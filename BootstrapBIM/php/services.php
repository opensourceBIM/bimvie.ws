<?
	header('Content-Type: application/json');
?>
{
	services: [
		{
			name: "Quantizator",
			description: "This service will count all objects and write an HTML report as Extended Data",
			url: "http://localhost/php/quantizator",
			notificationProtocol: "JSON",
			trigger: "NEW_REVISION",
			rights: {
				readRevision: true,
				writeRevision: false,
				readExtendedData: false,
				writeExtendedData: true
			}			
		},
		{
			name: "Logger",
			description: "This service will log all JSON representations of notifications in a database, content of the database is available at http://bimservertest.logic-labs.nl",
			url: "http://localhost/php/logger",
			notificationProtocol: "JSON",
			trigger: "NEW_REVISION",
			rights: {
				readRevision: false,
				writeRevision: false,
				readExtendedData: false,
				writeExtendedData: false
			}
		}
	]
}