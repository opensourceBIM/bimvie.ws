<script src="//ajax.googleapis.com/ajax/libs/jquery/1.8.1/jquery.min.js"></script>
<style>
pre {outline: 1px solid #ccc; padding: 5px; margin: 5px; }
.string { color: green; }
.number { color: darkorange; }
.boolean { color: blue; }
.null { color: magenta; }
.key { color: red; }
th {text-align: left}
</style>
<script>
function syntaxHighlight(json) {
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        var cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
            } else {
                cls = 'string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'boolean';
        } else if (/null/.test(match)) {
            cls = 'null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

$(function(){
	$(".json").each(function(){
		var pre = $("<pre>");
		pre.append(syntaxHighlight($(this).html()));
		$(this).empty().append(pre);
	});
});
</script>
<?
	include "header.php";
	
	$sql = "SELECT * FROM incoming";
	$result = mysql_query($sql);
?>
<table>
	<tr>
		<th>Received</th>
		<th>Message</th>
	</tr>
<?
	while ($row = mysql_fetch_assoc($result)) {
		echo "<tr>";
		echo "<td>" . $row['received'] . "</td><td class=\"json\">" . $row['message'] . "</td>";
		echo "</tr>";
	}
?>
</table>
<?
	include "footer.php";
?>