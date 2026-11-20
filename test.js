// test.js
// Direktivy pro PixInsight (volitelné, ale doporučené pro zařazení do menu)
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdButton.jsh>
#feature-id    Utilities > Hello World
#feature-info  Jednoduchý testovací skript vypisující Hello World do konzole.


// Hlavní funkce
function main() {
   // Výpis do hlavní konzole (Process Console)
   Console.show(); // Zajistí, že je konzole viditelná
   Console.writeln("<b>Hello World!</b>");
   Console.writeln("Toto je můj první skript v PixInsight.");

   // Zobrazení klasického vyskakovacího okna (MessageBox)
   var msg = new MessageBox(
      "Hello World!\n\nSkript úspěšně proběhl.", // Text zprávy
      "Můj první skript",                        // Nadpis okna
      StdIcon_Information,                       // Ikona informace
      StdButton_Ok                               // Tlačítko OK
   );
   msg.execute();
}

// Spuštění hlavní funkce
main();
