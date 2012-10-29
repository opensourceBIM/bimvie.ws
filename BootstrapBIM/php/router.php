<?
	function startsWith($haystack, $needle)
	{
	    $length = strlen($needle);
	    return (substr($haystack, 0, $length) === $needle);
	}
	
	function endsWith($haystack, $needle)
	{
	    $length = strlen($needle);
	    if ($length == 0) {
	        return true;
	    }
	
	    return (substr($haystack, -$length) === $needle);
	}

	if (startsWith($_SERVER['REQUEST_URI'], "/php/services")) {
		include "services.php";
	} else if (startsWith($_SERVER['REQUEST_URI'], "/php/logger")) {
		include "logger.php";
	} else if (startsWith($_SERVER['REQUEST_URI'], "/php/quantizator")) {
		include "quantizator.php";
	} else {
		echo "wrong url";
	}
?>