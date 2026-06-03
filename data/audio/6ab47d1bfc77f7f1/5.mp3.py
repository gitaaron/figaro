import sys
from gtts import gTTS
text = open(sys.argv[1], encoding='utf-8').read()
tts = gTTS(text=text, lang='en', slow=False)
tts.save(sys.argv[2])