var queriesIfc2x3tc1 = {
	AllObjects: {
		description: "IfcProduct is the super-type of all products like IfcWall, IfcWindow, IfcStair etc... So this query returns all products",
		query: {
			type: {
				name: "IfcProduct",
				includeAllSubTypes: true
			}
		}
	},
	AllWalls: {
		description: "This query returns all IfcWall objects, and also all IfcWallStandardCase objects because IfcWallStandardCase is a subtype of IfcWall",
		query: {
			type: {
				name: "IfcWall",
				includeAllSubTypes: true
			}
		}
	},
	AllWallsIncludingDecomposition: {
		description: "Returns all walls and includes the containment tree (up), owner history, representation and placement for every wall. Typically you'd want to include those 4 whenever you export to IFC with the intention of viewing/using the IFC geometry",
		query: {
			type: {
				name: "IfcWall",	
				includeAllSubTypes: true
			},
			includes: ["ifc2x3tc1-stdlib:ContainedInStructure", "ifc2x3tc1-stdlib:OwnerHistory", "ifc2x3tc1-stdlib:Representation", "ifc2x3tc1-stdlib:ObjectPlacement"]
		}
	},
	AllWallsIncludingWindowsAndDoors: {
		description: "Returns all walls and includes the openings and fillings (such as doors and windows) for each wall",
		query: {
			type: {
				name: "IfcWall",
				includeAllSubTypes: true,
			},
			include: {
				type: "IfcWall",
				field: "HasOpenings",
				include: {
					type: "IfcRelVoidsElement",
					field: "RelatedOpeningElement",
					include: {
						type: "IfcOpeningElement",
						field: "HasFillings",
						include: {
							type: "IfcRelFillsElement",
							field: "RelatedBuildingElement"
						}
					}
				}
			}
		}
	},
	AllWallsIncludingWindows: {
		description: "Returns all walls and includes the openings and fillings, but only when those are of type IfcWindow. This is essentially the same as the previous query, except that only windows are included",
		query: {
			type: {
				name: "IfcWall",
				includeAllSubTypes: true
			},
			include: {
				type: "IfcWall",
				field: "HasOpenings",
				include: {
					type: "IfcRelVoidsElement",
					field: "RelatedOpeningElement",
					include: {
						type: "IfcOpeningElement",
						field: "HasFillings",
						include: {
							type: "IfcRelFillsElement",
							field: "RelatedBuildingElement",
							outputType: "IfcWindow"
						}
					}
				}
			}
		}
	},
	AllWallsAndSlabs: {
		description: "Queries all walls and slabs, only IfcWall has subtypes so no subtypes required for IfcSlab",
		query: {
			types: [{
					name: "IfcWall",
					includeAllSubTypes: true
				}, {
					name: "IfcSlab"
				}],
		}
	},
	SpecificWallsByGuid: {
		description: "Queries the model for 3 specific walls, identified by their GUIDs. These GUIDs only work on the <a href=\"https://github.com/opensourceBIM/TestFiles/raw/master/TestData/data/AC11-Institute-Var-2-IFC.ifc\">AC11-Institute-Var-2-IFC.ifc</a> model. In this query you can ommit the whole \"type\" part but it could make the query a bit slower",
		query: {
			type: {
				name: "IfcWall",
				includeAllSubTypes: true
			},
			guids: ["2udBPbKibCZ8zbfpJmtDTM", "2V1MCFZRf1GA2ZyRufjYwX", "2oOoWKmmfChQTLCBzuB3$b"]
		}
	},
	SpecificBuildingStoreyIncContains: {
		description: "Query a specific building storey by GUID (test model: <a href=\"https://github.com/opensourceBIM/TestFiles/raw/master/TestData/data/AC11-Institute-Var-2-IFC.ifc\">AC11-Institute-Var-2-IFC.ifc</a>). Includes all directly contained objects",
		query: {
			type: "IfcBuildingStorey",
			guid: "25SMdCQszBi9al8gnrh8LV",
			include: {
				type: "IfcBuildingStorey",
				field: "ContainsElements",
				include: {
					type: "IfcRelContainedInSpatialStructure",
					field: "RelatedElements"
				}
			}
		}
	},
	AllPropertiesOf2Spaces1Wall: {
		description: "[BROKEN] Queries all properties of the given GUIDs (test model: <a href=\"https://github.com/opensourceBIM/TestFiles/raw/master/TestData/data/AC11-Institute-Var-2-IFC.ifc\">AC11-Institute-Var-2-IFC.ifc</a>). This query won't visualize anything",
		query: {
			guids: [
				"1geKZCJAHAVQxXKkYkD9nV",
				"1stYdhm21EUQMz3jV6WdHc",
				"05yuQkJxb22el7nxTgecJc"
			],
			includes: [
				"ifc2x3tc1-stdlib:AllProperties",
				"ifc2x3tc1-stdlib:ContainedInStructure",
				"ifc2x3tc1-stdlib:OwnerHistory",
				"ifc2x3tc1-stdlib:Representation",
				"ifc2x3tc1-stdlib:ObjectPlacement"
			]
		}
	},
	AllPropertiesOfAllWalls: {
		description: "Get all the properties of all IfcWall types",
		query: {
			doublebuffer: true,
			type: {
			    name: "IfcWall",
			    includeAllSubTypes: true
			  },
			  includes: [{
			    type: {
				  name: "IfcWall",
				  includeAllSubTypes: true
				},
			    fields: ["IsDefinedBy"],
			    includes: [{
			      type: "IfcRelDefinesByProperties",
			      fields: ["RelatingPropertyDefinition"],
			      includes: [{
			        type: "IfcPropertySet",
			        fields: ["HasProperties"]
			      }]
			    }
				]
			  },  "ifc2x3tc1-stdlib:ContainedInStructure",
			      "ifc2x3tc1-stdlib:OwnerHistory"]
			}
	},
	ExternalWalls: {
		description: "Queries for all external walls. The \"properties\" part of the query is a specialized type of query that will iterate over all property sets/properties linked to the object",
		query: {
			version: 2,
			type: {
				name: "IfcWall",
				includeAllSubTypes: true
			},
			properties: {
				Pset_WallCommon: {
					IsExternal: true
				}
			}
		}
	},
	ClassificationDakenConstructief: {
		description: "Queries all products that have a classification with the name \"57.2\". TODO: Link to a working test model that has these classifications",
		query: {
			type: {
				name: "IfcProduct",	
				includeAllSubTypes: true
			},
			classifications: [
				"57.2"
			]
		}
	},
	ThermalTransmittance: {
		description: "[NOT WORKING] At the moment, no compare functionalities have been implemented",
		query: {
			type: {
				name: "IfcWall",
				includeAllSubTypes: true
			},
			properties: {
				ThermalTransmittance: {
					comparator: ">",
					value: 0.2
				}
			}
		}
	},
	IfcPresentationLayerAssignment: {
		description: "Queries for all IfcPresentationLayerAssignments with the name \"Räume\", then shows all objects linked to it. Works with <a href=\"https://github.com/opensourceBIM/TestFiles/raw/master/TestData/data/AC11-Institute-Var-2-IFC.ifc\">AC11-Institute-Var-2-IFC.ifc</a> model",
		query: {
			type: "IfcPresentationLayerAssignment",
			name: "Räume",
			include: {
				type: "IfcPresentationLayerAssignment",
				field: "AssignedItems",
				includes: [{
					type: "IfcShapeRepresentation",
					fields: ["OfProductRepresentation"],
					includes: [{
						type: "IfcProductDefinitionShape",
						fields: ["ShapeOfProduct"]
					}]
				}]
			}
		}
	},
	ObjectInBoundingBox: {
		description: "Queries for all furnishing that completely fits inside the given bounding box, you can add the \"partial: true\" argument to also include partially contained objects",
		query: {
			type: "IfcFurnishingElement",
			inBoundingBox: {
				x: 0,
				y: 0,
				z: 0,
				width: 5,
				height: 5,
				depth: 5
			}
		}
	}
};
	
var queriesIfc4 = {
	AllObjects: {
		description: "AllObjects", query: {
		type: { name: "IfcProduct", includeAllSubTypes: true }
	}},
	AllWalls: {
		description: "AllWalls", query: {
		type: { name: "IfcWall", includeAllSubTypes: true }
	}},
	AllWallsIncludingDecomposition: {
		description: "AllWallsIncludingDecomposition", query: {
		type: { name: "IfcWall", includeAllSubTypes: true },
		includes: ["ifc4-stdlib:ContainedInStructure", "ifc4-stdlib:OwnerHistory", "ifc4-stdlib:Representation", "ifc4-stdlib:ObjectPlacement"]
	}},
	AllWallsIncludingWindowsAndDoors: {
		description: "AllWallsIncludingWindowsAndDoors", query: {
		type: { name: "IfcWall", includeAllSubTypes: true },
		include: {
			type: "IfcWall",
			field: "HasOpenings",
			include: {
				type: "IfcRelVoidsElement",
				field: "RelatedOpeningElement",
				include: {
					type: "IfcOpeningElement",
					field: "HasFillings",
					include: {
						type: "IfcRelFillsElement",
						field: "RelatedBuildingElement"
					}
				}
			}
		}
	}},
	AllWallsIncludingWindows: {
		description: "AllWallsIncludingWindows", query: {
		type: { name: "IfcWall", includeAllSubTypes: true },
		include: {
			type: "IfcWall",
			field: "HasOpenings",
			include: {
				type: "IfcRelVoidsElement",
				field: "RelatedOpeningElement",
				include: {
					type: "IfcOpeningElement",
					field: "HasFillings",
					include: {
						type: "IfcRelFillsElement",
						field: "RelatedBuildingElement",
						outputType: "IfcWindow"
					}
				}
			}
		}
	}},
	AllWallsAndSlabs: {
		description: "AllWallsAndSlabs", query: {
		types: [{name: "IfcWall"}, {name: "IfcSlab"}],
		includeAllSubTypes: true
	}},
	SpecificWallsByGuid: {
		description: "SpecificWallsByGuid", query: {
		type: {name: "IfcWall"},
		includeAllSubTypes: true,
		guids: ["2udBPbKibCZ8zbfpJmtDTM", "2V1MCFZRf1GA2ZyRufjYwX", "2oOoWKmmfChQTLCBzuB3$b"]
	}},
	SpecificBuildingStoreyIncContains: {
		description: "SpecificBuildingStoreyIncContains", query: {
		type: {name: "IfcBuildingStorey"},
		guid: "25SMdCQszBi9al8gnrh8LV",
		include: {
			type: "IfcBuildingStorey",
			field: "ContainsElements",
			include: {
				type: "IfcRelContainedInSpatialStructure",
				field: "RelatedElements"
			}
		}
	}},
	ExternalWalls: {
		description: "ExternalWalls", query: {
		type: {name: "IfcWall"},
		includeAllSubTypes: true,
		properties: {
			IsExternal: true
		}
	}},
	ThermalTransmittance: {
		description: "ThermalTransmittance", query: {
		type: {name: "IfcWall"},
		includeAllSubTypes: true,
		properties: {
			ThermalTransmittance: {
				comparator: ">",
				value: 0.2
			}
		}
	}},
	IfcPresentationLayerAssignment: {
		description: "IfcPresentationLayerAssignment", query: {
		type: {name: "IfcPresentationLayerAssignment"},
		name: "Räume",
		include: {
			type: "IfcPresentationLayerAssignment",
			field: "AssignedItems"
		}
	}},
	ObjectInBoundingBox: {
		description: "ObjectInBoundingBox", query: {
		type: {name: "IfcFurnishingElement"},
		inBoundingBox: {
			x: 0,
			y: 0,
			z: 0,
			width: 5,
			height: 5,
			depth: 5
		}
	}}
};