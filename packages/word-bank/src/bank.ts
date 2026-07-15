import type { PromptTopic } from "@drawguessai/game-core";

import {
  PromptEntrySchema,
  type PromptCategory,
  type PromptDifficulty,
  type PromptEntry
} from "./schema";

interface Phrase {
  zh: string;
  en: string;
  topic?: PromptTopic;
}

interface PromptGroup {
  category: PromptCategory;
  topic: PromptTopic;
  items: readonly Phrase[];
  cultureTags?: readonly string[];
}

const GROUPS: readonly PromptGroup[] = [
  {
    category: "objects",
    topic: "daily-object",
    items: [
      { zh: "雨伞", en: "umbrella" },
      { zh: "闹钟", en: "alarm clock" },
      { zh: "自行车", en: "bicycle" },
      { zh: "吉他", en: "guitar" },
      { zh: "钥匙", en: "key" },
      { zh: "蜡烛", en: "candle" },
      { zh: "眼镜", en: "glasses" },
      { zh: "相机", en: "camera" },
      { zh: "牙刷", en: "toothbrush" },
      { zh: "剪刀", en: "scissors" },
      { zh: "手电筒", en: "flashlight" },
      { zh: "行李箱", en: "suitcase" },
      { zh: "风筝", en: "kite" },
      { zh: "气球", en: "balloon" },
      { zh: "茶壶", en: "teapot" },
      { zh: "镜子", en: "mirror" },
      { zh: "枕头", en: "pillow" },
      { zh: "台灯", en: "desk lamp" },
      { zh: "锤子", en: "hammer" },
      { zh: "梯子", en: "ladder" },
      { zh: "冰箱", en: "refrigerator" },
      { zh: "洗衣机", en: "washing machine" },
      { zh: "电话", en: "telephone" },
      { zh: "电脑", en: "computer" },
      { zh: "背包", en: "backpack" },
      { zh: "指南针", en: "compass" },
      { zh: "望远镜", en: "telescope" },
      { zh: "沙漏", en: "hourglass" },
      { zh: "皇冠", en: "crown" },
      { zh: "机器人", en: "robot" },
      { zh: "雪人", en: "snowman" },
      { zh: "礼物盒", en: "gift box" },
      { zh: "纸飞机", en: "paper airplane" },
      { zh: "存钱罐", en: "piggy bank" },
      { zh: "灭火器", en: "fire extinguisher" }
    ]
  },
  {
    category: "animals",
    topic: "animal",
    items: [
      { zh: "猫", en: "cat" },
      { zh: "狗", en: "dog" },
      { zh: "熊猫", en: "panda" },
      { zh: "兔子", en: "rabbit" },
      { zh: "大象", en: "elephant" },
      { zh: "狮子", en: "lion" },
      { zh: "老虎", en: "tiger" },
      { zh: "长颈鹿", en: "giraffe" },
      { zh: "猴子", en: "monkey" },
      { zh: "企鹅", en: "penguin" },
      { zh: "海豚", en: "dolphin" },
      { zh: "鲸鱼", en: "whale" },
      { zh: "鲨鱼", en: "shark" },
      { zh: "章鱼", en: "octopus" },
      { zh: "乌龟", en: "turtle" },
      { zh: "青蛙", en: "frog" },
      { zh: "猫头鹰", en: "owl" },
      { zh: "老鹰", en: "eagle" },
      { zh: "孔雀", en: "peacock" },
      { zh: "蝴蝶", en: "butterfly" },
      { zh: "蜜蜂", en: "bee" },
      { zh: "蚂蚁", en: "ant" },
      { zh: "蜗牛", en: "snail" },
      { zh: "螃蟹", en: "crab" },
      { zh: "金鱼", en: "goldfish" },
      { zh: "马", en: "horse" },
      { zh: "奶牛", en: "cow" },
      { zh: "绵羊", en: "sheep" },
      { zh: "小猪", en: "pig" },
      { zh: "公鸡", en: "rooster" },
      { zh: "鸭子", en: "duck" },
      { zh: "骆驼", en: "camel" },
      { zh: "松鼠", en: "squirrel" },
      { zh: "考拉", en: "koala" },
      { zh: "刺猬", en: "hedgehog" }
    ]
  },
  {
    category: "actions",
    topic: "action",
    items: [
      { zh: "刷牙", en: "brushing teeth" },
      { zh: "洗脸", en: "washing face" },
      { zh: "梳头", en: "combing hair" },
      { zh: "穿鞋", en: "putting on shoes" },
      { zh: "做饭", en: "cooking dinner" },
      { zh: "洗碗", en: "washing dishes" },
      { zh: "打扫房间", en: "cleaning a room" },
      { zh: "晾衣服", en: "hanging laundry" },
      { zh: "读书", en: "reading a book" },
      { zh: "写作业", en: "doing homework" },
      { zh: "打电话", en: "making a phone call" },
      { zh: "拍照", en: "taking a photo" },
      { zh: "唱歌", en: "singing a song" },
      { zh: "跳舞", en: "dancing" },
      { zh: "睡觉", en: "sleeping" },
      { zh: "打喷嚏", en: "sneezing" },
      { zh: "打哈欠", en: "yawning" },
      { zh: "哭泣", en: "crying" },
      { zh: "大笑", en: "laughing loudly" },
      { zh: "握手", en: "shaking hands" },
      { zh: "拥抱", en: "giving a hug" },
      { zh: "排队", en: "waiting in line" },
      { zh: "开门", en: "opening a door" },
      { zh: "关灯", en: "turning off the light" },
      { zh: "浇花", en: "watering flowers" },
      { zh: "遛狗", en: "walking a dog" },
      { zh: "放风筝", en: "flying a kite" },
      { zh: "堆雪人", en: "building a snowman" },
      { zh: "钓鱼", en: "fishing" },
      { zh: "爬树", en: "climbing a tree" },
      { zh: "过马路", en: "crossing the street" },
      { zh: "搬箱子", en: "carrying a box" },
      { zh: "修自行车", en: "fixing a bicycle" },
      { zh: "吹蜡烛", en: "blowing out a candle" },
      { zh: "拆礼物", en: "opening a present" }
    ]
  },
  {
    category: "daily-scenes",
    topic: "daily-life",
    items: [
      { zh: "等公交", en: "waiting for the bus" },
      { zh: "赶地铁", en: "catching the subway" },
      { zh: "超市购物", en: "grocery shopping" },
      { zh: "菜市场买菜", en: "shopping at the market" },
      { zh: "餐厅点菜", en: "ordering at a restaurant" },
      { zh: "排队买票", en: "lining up for tickets" },
      { zh: "堵车", en: "traffic jam" },
      { zh: "下班回家", en: "going home from work" },
      { zh: "上学迟到", en: "late for school" },
      { zh: "雨中奔跑", en: "running in the rain" },
      { zh: "忘带钥匙", en: "forgetting the keys" },
      { zh: "手机没电", en: "dead phone battery" },
      { zh: "停电", en: "power outage" },
      { zh: "搬家", en: "moving house" },
      { zh: "大扫除", en: "spring cleaning" },
      { zh: "生日聚会", en: "birthday party" },
      { zh: "家庭合影", en: "family photo" },
      { zh: "公园野餐", en: "picnic in the park" },
      { zh: "海边散步", en: "walking by the sea" },
      { zh: "遛狗遇见猫", en: "dog meeting a cat" },
      { zh: "抢最后一块蛋糕", en: "reaching for the last cake" },
      { zh: "电梯满员", en: "crowded elevator" },
      { zh: "错过闹钟", en: "sleeping through the alarm" },
      { zh: "找不到眼镜", en: "looking for glasses" },
      { zh: "咖啡洒了", en: "spilled coffee" },
      { zh: "排队结账", en: "waiting at checkout" },
      { zh: "雨伞被风吹走", en: "umbrella blown away" },
      { zh: "做饭烧糊了", en: "burnt dinner" },
      { zh: "水管漏水", en: "leaking pipe" },
      { zh: "熬夜加班", en: "working late" },
      { zh: "周末赖床", en: "sleeping in on weekends" },
      { zh: "邻居敲门", en: "neighbor at the door" },
      { zh: "快递送到", en: "package delivery" },
      { zh: "拍毕业照", en: "graduation photo" },
      { zh: "机场接人", en: "meeting someone at the airport" }
    ]
  },
  {
    category: "people-at-work",
    topic: "person",
    items: [
      { zh: "老师上课", en: "teacher giving a lesson" },
      { zh: "医生看病", en: "doctor seeing a patient" },
      { zh: "护士打针", en: "nurse giving an injection" },
      { zh: "警察指挥交通", en: "police directing traffic" },
      { zh: "消防员灭火", en: "firefighter putting out a fire" },
      { zh: "厨师炒菜", en: "chef cooking" },
      { zh: "理发师剪头发", en: "barber cutting hair" },
      { zh: "司机开公交", en: "bus driver driving" },
      { zh: "飞行员开飞机", en: "pilot flying a plane" },
      { zh: "农民收割", en: "farmer harvesting" },
      { zh: "渔夫撒网", en: "fisher casting a net" },
      { zh: "建筑工人砌墙", en: "builder laying bricks" },
      { zh: "画家画画", en: "painter at work" },
      { zh: "摄影师拍婚礼", en: "wedding photographer" },
      { zh: "记者采访", en: "reporter interviewing" },
      { zh: "歌手开演唱会", en: "singer performing" },
      { zh: "演员谢幕", en: "actor taking a bow" },
      { zh: "舞者排练", en: "dancer rehearsing" },
      { zh: "裁缝量尺寸", en: "tailor taking measurements" },
      { zh: "木匠做桌子", en: "carpenter making a table" },
      { zh: "邮递员送信", en: "mail carrier delivering letters" },
      { zh: "快递员送包裹", en: "courier delivering a package" },
      { zh: "面包师烤面包", en: "baker baking bread" },
      { zh: "服务员端菜", en: "waiter serving food" },
      { zh: "牙医拔牙", en: "dentist pulling a tooth" },
      { zh: "兽医检查小狗", en: "vet examining a dog" },
      { zh: "园丁修剪树篱", en: "gardener trimming a hedge" },
      { zh: "清洁工擦窗", en: "cleaner washing windows" },
      { zh: "宇航员太空行走", en: "astronaut spacewalk" },
      { zh: "潜水员海底探索", en: "diver exploring underwater" },
      { zh: "科学家做实验", en: "scientist doing an experiment" },
      { zh: "魔术师变鸽子", en: "magician producing a dove" },
      { zh: "运动员领奖", en: "athlete receiving a medal" },
      { zh: "指挥家挥棒", en: "conductor leading an orchestra" },
      { zh: "图书管理员整理书", en: "librarian shelving books" }
    ]
  },
  {
    category: "nature-weather",
    topic: "nature",
    items: [
      { zh: "太阳升起", en: "sunrise" },
      { zh: "夕阳西下", en: "sunset" },
      { zh: "满天星星", en: "starry sky" },
      { zh: "月亮倒影", en: "moon reflection" },
      { zh: "雨后彩虹", en: "rainbow after rain" },
      { zh: "电闪雷鸣", en: "thunder and lightning", topic: "weather" },
      { zh: "大雪纷飞", en: "heavy snowfall", topic: "weather" },
      { zh: "秋风落叶", en: "falling autumn leaves" },
      { zh: "春暖花开", en: "spring flowers blooming" },
      { zh: "海上日出", en: "sunrise over the sea" },
      { zh: "山顶云海", en: "sea of clouds" },
      { zh: "火山喷发", en: "volcanic eruption" },
      { zh: "瀑布", en: "waterfall" },
      { zh: "沙尘暴", en: "sandstorm", topic: "weather" },
      { zh: "龙卷风", en: "tornado", topic: "weather" },
      { zh: "海浪拍岸", en: "waves hitting the shore" },
      { zh: "流星", en: "shooting star" },
      { zh: "日食", en: "solar eclipse" },
      { zh: "月食", en: "lunar eclipse" },
      { zh: "北极光", en: "northern lights" },
      { zh: "冰山融化", en: "melting iceberg" },
      { zh: "河水结冰", en: "frozen river" },
      { zh: "花朵开放", en: "flower blooming" },
      { zh: "种子发芽", en: "seed sprouting" },
      { zh: "蜜蜂采蜜", en: "bee gathering nectar" },
      { zh: "蜘蛛结网", en: "spider spinning a web" },
      { zh: "鸟儿筑巢", en: "bird building a nest" },
      { zh: "鱼儿跃出水面", en: "fish jumping out of water" },
      { zh: "树被风吹弯", en: "tree bending in the wind", topic: "weather" },
      { zh: "闪电劈树", en: "lightning striking a tree", topic: "weather" },
      { zh: "雨滴打窗", en: "rain on a window", topic: "weather" },
      { zh: "雾中灯塔", en: "lighthouse in fog", topic: "weather" },
      { zh: "沙漠绿洲", en: "desert oasis" },
      { zh: "山洪暴发", en: "flash flood" },
      { zh: "森林大火", en: "forest fire" }
    ]
  },
  {
    category: "sports",
    topic: "sport",
    items: [
      { zh: "踢足球", en: "playing soccer" },
      { zh: "打篮球", en: "playing basketball" },
      { zh: "打排球", en: "playing volleyball" },
      { zh: "打乒乓球", en: "playing table tennis" },
      { zh: "打羽毛球", en: "playing badminton" },
      { zh: "打网球", en: "playing tennis" },
      { zh: "游泳", en: "swimming" },
      { zh: "跳水", en: "diving" },
      { zh: "冲浪", en: "surfing" },
      { zh: "滑雪", en: "skiing" },
      { zh: "滑冰", en: "ice skating" },
      { zh: "骑自行车", en: "cycling" },
      { zh: "跑步", en: "running" },
      { zh: "接力赛", en: "relay race" },
      { zh: "跨栏", en: "hurdling" },
      { zh: "跳高", en: "high jump" },
      { zh: "跳远", en: "long jump" },
      { zh: "举重", en: "weightlifting" },
      { zh: "拳击", en: "boxing" },
      { zh: "击剑", en: "fencing" },
      { zh: "射箭", en: "archery" },
      { zh: "体操", en: "gymnastics" },
      { zh: "瑜伽", en: "yoga" },
      { zh: "拔河", en: "tug of war" },
      { zh: "跳绳", en: "jumping rope" },
      { zh: "踢毽子", en: "kicking a shuttlecock" },
      { zh: "打棒球", en: "playing baseball" },
      { zh: "打高尔夫", en: "playing golf" },
      { zh: "划船", en: "rowing" },
      { zh: "赛龙舟", en: "dragon boat racing" },
      { zh: "爬山", en: "mountain climbing" },
      { zh: "攀岩", en: "rock climbing" },
      { zh: "滑板", en: "skateboarding" },
      { zh: "保龄球", en: "bowling" },
      { zh: "领奖台", en: "medal podium" }
    ]
  },
  {
    category: "food-scenes",
    topic: "food",
    items: [
      { zh: "吃火锅", en: "eating hot pot" },
      { zh: "包饺子", en: "making dumplings" },
      { zh: "煮面条", en: "cooking noodles" },
      { zh: "烤蛋糕", en: "baking a cake" },
      { zh: "切西瓜", en: "cutting a watermelon", topic: "fruit" },
      { zh: "剥香蕉", en: "peeling a banana", topic: "fruit" },
      { zh: "吃冰淇淋", en: "eating ice cream" },
      { zh: "喝珍珠奶茶", en: "drinking bubble tea" },
      { zh: "烤串", en: "barbecue skewers" },
      { zh: "做三明治", en: "making a sandwich" },
      { zh: "煎鸡蛋", en: "frying an egg" },
      { zh: "烤面包", en: "making toast" },
      { zh: "吹生日蜡烛", en: "blowing birthday candles" },
      { zh: "抢最后一片披萨", en: "last slice of pizza" },
      { zh: "辣到流泪", en: "crying from spicy food" },
      { zh: "面条太长", en: "very long noodles" },
      { zh: "爆米花溢出", en: "overflowing popcorn" },
      { zh: "饼干掉进牛奶", en: "cookie in milk" },
      { zh: "早餐煎糊", en: "burnt breakfast" },
      { zh: "餐桌上的大餐", en: "feast on a table" },
      { zh: "野餐篮", en: "picnic basket" },
      { zh: "水果拼盘", en: "fruit platter", topic: "fruit" },
      { zh: "糖葫芦", en: "candied hawthorn", topic: "fruit" },
      { zh: "月饼", en: "mooncake" },
      { zh: "粽子", en: "rice dumpling" },
      { zh: "北京烤鸭", en: "Peking duck" },
      { zh: "麻婆豆腐", en: "mapo tofu" },
      { zh: "汉堡薯条", en: "burger and fries" },
      { zh: "寿司拼盘", en: "sushi platter" },
      { zh: "咖啡拉花", en: "latte art" },
      { zh: "棉花糖", en: "cotton candy" },
      { zh: "巧克力喷泉", en: "chocolate fountain" },
      { zh: "火锅太辣", en: "spicy hot pot" },
      { zh: "饺子露馅", en: "broken dumpling" },
      { zh: "偷吃夜宵", en: "sneaking a midnight snack" }
    ]
  },
  {
    category: "transport-travel",
    topic: "transport",
    items: [
      { zh: "飞机起飞", en: "airplane taking off" },
      { zh: "飞机降落", en: "airplane landing" },
      { zh: "火车进站", en: "train arriving" },
      { zh: "轮船出港", en: "ship leaving the harbor" },
      { zh: "公交到站", en: "bus arriving" },
      { zh: "地铁关门", en: "subway doors closing" },
      { zh: "出租车招手", en: "hailing a taxi" },
      { zh: "骑车上坡", en: "cycling uphill" },
      { zh: "汽车爆胎", en: "flat tire" },
      { zh: "加油站", en: "refueling at a gas station" },
      { zh: "等红灯", en: "waiting at a red light" },
      { zh: "过斑马线", en: "crossing a crosswalk" },
      { zh: "错过火车", en: "missing the train" },
      { zh: "赶飞机", en: "rushing for a flight" },
      { zh: "收拾行李", en: "packing luggage", topic: "travel" },
      { zh: "机场安检", en: "airport security", topic: "travel" },
      { zh: "领取行李", en: "collecting luggage", topic: "travel" },
      { zh: "城市迷路", en: "lost in a city", topic: "travel" },
      { zh: "看地图", en: "reading a map", topic: "travel" },
      { zh: "问路", en: "asking for directions", topic: "travel" },
      { zh: "公路旅行", en: "road trip", topic: "travel" },
      { zh: "露营", en: "camping", topic: "travel" },
      { zh: "搭帐篷", en: "pitching a tent", topic: "travel" },
      { zh: "登山看日出", en: "hiking for sunrise", topic: "travel" },
      { zh: "海边度假", en: "beach vacation", topic: "travel" },
      { zh: "乘热气球", en: "hot air balloon ride", topic: "travel" },
      { zh: "坐过山车", en: "riding a roller coaster", topic: "travel" },
      { zh: "摩托车比赛", en: "motorcycle race" },
      { zh: "堵在隧道", en: "traffic in a tunnel" },
      { zh: "校车接学生", en: "school bus pickup" },
      { zh: "救护车让行", en: "making way for an ambulance" },
      { zh: "消防车出动", en: "fire engine responding" },
      { zh: "拖车拉汽车", en: "tow truck hauling a car" },
      { zh: "船上晕船", en: "seasick on a boat", topic: "travel" },
      { zh: "车站告别", en: "farewell at the station", topic: "travel" }
    ]
  },
  {
    category: "festivals-culture",
    topic: "festival",
    cultureTags: ["Chinese", "international"],
    items: [
      { zh: "春节贴春联", en: "hanging Spring Festival couplets" },
      { zh: "拜年", en: "New Year greetings" },
      { zh: "发红包", en: "giving red envelopes" },
      { zh: "舞龙", en: "dragon dance" },
      { zh: "舞狮", en: "lion dance" },
      { zh: "放鞭炮", en: "setting off firecrackers" },
      { zh: "元宵节看花灯", en: "Lantern Festival lights" },
      { zh: "猜灯谜", en: "guessing lantern riddles" },
      { zh: "清明扫墓", en: "tomb sweeping" },
      { zh: "端午赛龙舟", en: "Dragon Boat Festival race" },
      { zh: "中秋赏月", en: "admiring the moon" },
      { zh: "圣诞树", en: "Christmas tree" },
      { zh: "圣诞老人送礼", en: "Santa delivering gifts" },
      { zh: "万圣节南瓜灯", en: "jack o lantern" },
      { zh: "万圣节讨糖", en: "trick or treating" },
      { zh: "复活节彩蛋", en: "Easter eggs" },
      { zh: "婚礼抛花", en: "wedding bouquet toss" },
      { zh: "新娘新郎", en: "bride and groom" },
      { zh: "毕业典礼", en: "graduation ceremony" },
      { zh: "升旗仪式", en: "flag raising ceremony" },
      { zh: "庙会", en: "temple fair" },
      { zh: "看京剧", en: "watching Beijing opera", topic: "culture" },
      { zh: "写毛笔字", en: "Chinese calligraphy", topic: "culture" },
      { zh: "舞台变脸", en: "face changing opera", topic: "culture" },
      { zh: "皮影戏", en: "shadow puppetry", topic: "culture" },
      { zh: "剪纸", en: "paper cutting", topic: "culture" },
      { zh: "包粽子", en: "wrapping rice dumplings" },
      { zh: "做月饼", en: "making mooncakes" },
      { zh: "生日许愿", en: "birthday wish" },
      { zh: "跨年倒计时", en: "New Year countdown" },
      { zh: "烟花表演", en: "fireworks show" },
      { zh: "狂欢游行", en: "carnival parade" },
      { zh: "家庭团圆", en: "family reunion" },
      { zh: "祭祖", en: "ancestor remembrance" },
      { zh: "扭秧歌", en: "yangge dance", topic: "culture" }
    ]
  },
  {
    category: "idioms",
    topic: "wisdom",
    cultureTags: ["Chinese", "idiom"],
    items: [
      { zh: "守株待兔", en: "waiting by a stump for a rabbit" },
      { zh: "画蛇添足", en: "drawing legs on a snake" },
      { zh: "掩耳盗铃", en: "covering ears while stealing a bell" },
      { zh: "亡羊补牢", en: "mending the pen after losing sheep" },
      { zh: "井底之蛙", en: "frog at the bottom of a well" },
      { zh: "狐假虎威", en: "fox borrowing the tiger power" },
      { zh: "对牛弹琴", en: "playing music to a cow" },
      { zh: "盲人摸象", en: "blind people feeling an elephant" },
      { zh: "刻舟求剑", en: "marking a boat to find a sword", topic: "history" },
      { zh: "揠苗助长", en: "pulling seedlings to help them grow" },
      { zh: "杯弓蛇影", en: "mistaking a reflection for a snake" },
      { zh: "鹤立鸡群", en: "a crane among chickens" },
      { zh: "鸡飞狗跳", en: "chickens flying and dogs jumping" },
      { zh: "狼吞虎咽", en: "wolfing down food" },
      { zh: "走马观花", en: "viewing flowers on horseback" },
      { zh: "雪中送炭", en: "sending charcoal in the snow" },
      { zh: "锦上添花", en: "adding flowers to brocade" },
      { zh: "火上浇油", en: "adding fuel to the fire" },
      { zh: "水落石出", en: "truth revealed when the water falls" },
      { zh: "一箭双雕", en: "two birds with one arrow" },
      { zh: "三心二意", en: "being in two minds" },
      { zh: "七上八下", en: "heart in a flutter" },
      { zh: "手忙脚乱", en: "all hands in a panic" },
      { zh: "目瞪口呆", en: "staring in shock" },
      { zh: "眉开眼笑", en: "beaming with joy" },
      { zh: "捧腹大笑", en: "laughing with a shaking belly" },
      { zh: "东张西望", en: "looking all around" },
      { zh: "抓耳挠腮", en: "scratching the head in worry" },
      { zh: "蹑手蹑脚", en: "walking on tiptoe" },
      { zh: "大海捞针", en: "finding a needle in the sea" },
      { zh: "纸上谈兵", en: "discussing war on paper", topic: "history" },
      { zh: "滥竽充数", en: "pretending to play the flute", topic: "history" },
      { zh: "叶公好龙", en: "Lord Ye loving dragons", topic: "history" },
      { zh: "自相矛盾", en: "self contradiction", topic: "history" },
      { zh: "塞翁失马", en: "a blessing in disguise", topic: "history" },
      { zh: "破镜重圆", en: "a broken mirror made whole" },
      { zh: "愚公移山", en: "old man moves mountains", topic: "history" },
      { zh: "骑虎难下", en: "unable to dismount a tiger" },
      { zh: "闻鸡起舞", en: "dancing at the rooster's crow", topic: "history" },
      { zh: "卧薪尝胆", en: "sleeping on brushwood and tasting gall", topic: "history" },
      { zh: "草船借箭", en: "borrowing arrows with straw boats", topic: "history" },
      { zh: "指鹿为马", en: "calling a deer a horse", topic: "history" },
      { zh: "黔驴技穷", en: "Guizhou donkey runs out of tricks" },
      { zh: "一叶障目", en: "one leaf blocks the whole view" },
      { zh: "囊萤映雪", en: "studying by fireflies in a bag", topic: "learning" },
      { zh: "画龙点睛", en: "dotting the dragon's eyes" },
      { zh: "惊弓之鸟", en: "bird frightened by a bow" },
      { zh: "如鱼得水", en: "like a fish in water" },
      { zh: "虎头蛇尾", en: "tiger head and snake tail" },
      { zh: "螳螂捕蝉", en: "mantis stalks a cicada" }
    ]
  },
  {
    category: "proverbs",
    topic: "wisdom",
    cultureTags: ["Chinese", "proverb"],
    items: [
      { zh: "百闻不如一见", en: "seeing once beats hearing a hundred times" },
      { zh: "早起的鸟儿有虫吃", en: "the early bird catches the worm" },
      { zh: "一分耕耘一分收获", en: "no pain no gain" },
      { zh: "失败是成功之母", en: "failure is the mother of success" },
      { zh: "世上无难事只怕有心人", en: "nothing is hard for the determined" },
      { zh: "人多力量大", en: "many hands make light work" },
      { zh: "众人拾柴火焰高", en: "many hands build a bigger fire" },
      { zh: "熟能生巧", en: "practice makes perfect" },
      { zh: "趁热打铁", en: "strike while the iron is hot" },
      { zh: "滴水穿石", en: "constant dripping wears away stone" },
      { zh: "千里之行始于足下", en: "a long journey begins with one step" },
      { zh: "吃一堑长一智", en: "learn from every mistake" },
      { zh: "远水救不了近火", en: "distant water cannot put out a nearby fire" },
      { zh: "不怕慢就怕站", en: "slow progress beats standing still" },
      { zh: "留得青山在不怕没柴烧", en: "where there is life there is hope" },
      { zh: "三个臭皮匠顶个诸葛亮", en: "three heads are better than one" },
      { zh: "在家靠父母出门靠朋友", en: "family at home and friends abroad" },
      { zh: "路遥知马力日久见人心", en: "time reveals a true character" },
      { zh: "书到用时方恨少", en: "knowledge feels scarce when needed" },
      { zh: "活到老学到老", en: "never too old to learn" },
      { zh: "饭后百步走活到九十九", en: "walk after meals for a long life" },
      { zh: "冬练三九夏练三伏", en: "practice through winter and summer" },
      { zh: "台上一分钟台下十年功", en: "one minute onstage takes ten years practice" },
      { zh: "若要人不知除非己莫为", en: "there is no secret if you do it" },
      { zh: "只要功夫深铁杵磨成针", en: "persistence can grind iron into a needle" },
      { zh: "好记性不如烂笔头", en: "the shortest pencil beats the longest memory" },
      { zh: "赠人玫瑰手有余香", en: "kindness leaves a lasting fragrance" },
      { zh: "家和万事兴", en: "harmony brings family prosperity" },
      { zh: "有志者事竟成", en: "where there is a will there is a way" },
      { zh: "读万卷书行万里路", en: "read widely and travel far" },
      { zh: "不经风雨怎见彩虹", en: "there is no rainbow without rain" },
      { zh: "金无足赤人无完人", en: "nobody is perfect" },
      { zh: "知己知彼百战不殆", en: "know yourself and your opponent" },
      { zh: "独木不成林", en: "one tree does not make a forest" },
      { zh: "一寸光阴一寸金", en: "time is precious" },
      { zh: "磨刀不误砍柴工", en: "sharpening the axe never delays woodcutting" },
      { zh: "种瓜得瓜种豆得豆", en: "plant melons reap melons plant beans reap beans" },
      { zh: "瑞雪兆丰年", en: "timely snow promises a good harvest", topic: "weather" },
      { zh: "春雨贵如油", en: "spring rain is precious as oil", topic: "weather" },
      { zh: "人心齐泰山移", en: "united hearts can move Mount Tai" },
      { zh: "船到桥头自然直", en: "the boat straightens when it reaches the bridge" },
      { zh: "靠山吃山靠水吃水", en: "live from the mountain or the water nearby" },
      { zh: "一场秋雨一场寒", en: "each autumn rain brings more cold", topic: "weather" },
      { zh: "尺有所短寸有所长", en: "every strength has its weakness" },
      { zh: "冰冻三尺非一日之寒", en: "three feet of ice takes more than one cold day" },
      { zh: "万事开头难", en: "every beginning is difficult" },
      { zh: "好马不吃回头草", en: "a good horse never eats turned-back grass" },
      { zh: "没有规矩不成方圆", en: "without rules no square or circle can be made" },
      { zh: "不入虎穴焉得虎子", en: "nothing ventured in a tiger den gains no cub" },
      { zh: "一日之计在于晨", en: "the day's plan starts in the morning" }
    ]
  },
  {
    category: "poem-lines",
    topic: "nature",
    cultureTags: ["Chinese", "classical-poetry"],
    items: [
      { zh: "床前明月光", en: "moonlight before my bed" },
      { zh: "举头望明月", en: "raising my head to the bright moon" },
      { zh: "低头思故乡", en: "lowering my head I think of home", topic: "emotion" },
      { zh: "春眠不觉晓", en: "spring sleep goes unnoticed at dawn" },
      { zh: "处处闻啼鸟", en: "birdsong is heard everywhere" },
      { zh: "夜来风雨声", en: "sounds of wind and rain came overnight", topic: "weather" },
      { zh: "花落知多少", en: "who knows how many flowers have fallen" },
      { zh: "白日依山尽", en: "the white sun sets behind mountains" },
      { zh: "黄河入海流", en: "the Yellow River flows into the sea" },
      { zh: "欲穷千里目", en: "to see a thousand miles farther" },
      { zh: "更上一层楼", en: "climb one story higher" },
      { zh: "两个黄鹂鸣翠柳", en: "two golden orioles sing in green willows" },
      { zh: "一行白鹭上青天", en: "a row of egrets climbs the blue sky" },
      { zh: "窗含西岭千秋雪", en: "my window frames snowy western peaks", topic: "weather" },
      { zh: "门泊东吴万里船", en: "boats from eastern Wu rest by my door", topic: "travel" },
      { zh: "飞流直下三千尺", en: "waterfalls plunge three thousand feet" },
      { zh: "疑是银河落九天", en: "like the Milky Way falling from heaven" },
      { zh: "小荷才露尖尖角", en: "a young lotus bud shows its tip" },
      { zh: "早有蜻蜓立上头", en: "a dragonfly already perches on top", topic: "animal" },
      { zh: "竹外桃花三两枝", en: "peach blossoms peek beyond the bamboo" },
      { zh: "春江水暖鸭先知", en: "ducks first feel the spring river warm", topic: "animal" },
      { zh: "孤舟蓑笠翁", en: "a lone boatman in a bamboo cloak", topic: "person" },
      { zh: "独钓寒江雪", en: "fishing alone on the cold snowy river", topic: "weather" },
      { zh: "牧童遥指杏花村", en: "a shepherd boy points toward Apricot Village", topic: "person" },
      { zh: "儿童散学归来早", en: "children leave school early", topic: "learning" },
      { zh: "忙趁东风放纸鸢", en: "flying kites in the spring breeze", topic: "action" },
      { zh: "一枝红杏出墙来", en: "a red apricot branch reaches over the wall" },
      { zh: "接天莲叶无穷碧", en: "endless lotus leaves touch the sky" },
      { zh: "映日荷花别样红", en: "sunlit lotus flowers glow bright red" },
      { zh: "大漠孤烟直", en: "a lone desert smoke rises straight" },
      { zh: "长河落日圆", en: "the long river holds the setting sun" },
      { zh: "明月松间照", en: "moonlight shines between the pines" },
      { zh: "清泉石上流", en: "a clear spring flows over stones" },
      { zh: "月落乌啼霜满天", en: "moon sets as crows cry under frosty skies", topic: "weather" },
      {
        zh: "江枫渔火对愁眠",
        en: "maples and fishing lights face my sleepless night",
        topic: "emotion"
      }
    ]
  },
  {
    category: "xiehouyu",
    topic: "wisdom",
    cultureTags: ["Chinese", "xiehouyu"],
    items: [
      {
        zh: "八仙过海，各显神通",
        en: "eight immortals cross the sea showing their powers",
        topic: "culture"
      },
      {
        zh: "泥菩萨过江，自身难保",
        en: "clay idol crosses river unable to save itself",
        topic: "culture"
      },
      {
        zh: "竹篮打水，一场空",
        en: "bamboo basket draws water all for nothing",
        topic: "daily-object"
      },
      { zh: "猫哭耗子，假慈悲", en: "cat cries over mouse with false sympathy", topic: "animal" },
      {
        zh: "黄鼠狼给鸡拜年，没安好心",
        en: "weasel visits chicken while plotting no good",
        topic: "animal"
      },
      {
        zh: "哑巴吃黄连，有苦说不出",
        en: "mute eats bitter herbs and suffers in silence",
        topic: "person"
      },
      {
        zh: "骑驴看唱本，走着瞧",
        en: "riding a donkey watching opera wait and see",
        topic: "travel"
      },
      { zh: "外甥打灯笼，照旧", en: "nephew carries lantern same as before", topic: "daily-life" },
      {
        zh: "小葱拌豆腐，一清二白",
        en: "scallions with tofu perfectly clear and white",
        topic: "food"
      },
      { zh: "芝麻开花，节节高", en: "sesame flowers bloom rising joint by joint", topic: "nature" },
      { zh: "丈二和尚，摸不着头脑", en: "tall monk cannot make head or tail", topic: "culture" },
      { zh: "老鼠过街，人人喊打", en: "rat crosses street and everyone shouts", topic: "animal" },
      {
        zh: "十五个吊桶打水，七上八下",
        en: "fifteen buckets draw water seven up eight down",
        topic: "daily-object"
      },
      {
        zh: "狗拿耗子，多管闲事",
        en: "dog catches mice and meddles in others' business",
        topic: "animal"
      },
      {
        zh: "孔夫子搬家，尽是书",
        en: "Confucius moves house with nothing but books",
        topic: "history"
      },
      { zh: "铁公鸡，一毛不拔", en: "iron rooster refuses to spare one feather", topic: "animal" },
      { zh: "热锅上的蚂蚁，团团转", en: "ants on a hot pan run in circles", topic: "animal" },
      {
        zh: "猪八戒照镜子，里外不是人",
        en: "Pigsy looks in mirror wrong on both sides",
        topic: "culture"
      },
      {
        zh: "姜太公钓鱼，愿者上钩",
        en: "Jiang Ziya fishes and willing fish take the hook",
        topic: "history"
      },
      { zh: "和尚打伞，无法无天", en: "monk under umbrella answers to no law", topic: "culture" },
      {
        zh: "擀面杖吹火，一窍不通",
        en: "rolling pin blows fire and knows nothing",
        topic: "daily-object"
      },
      {
        zh: "茶壶里煮饺子，有货倒不出",
        en: "dumplings in teapot cannot be poured out",
        topic: "food"
      },
      { zh: "兔子尾巴，长不了", en: "rabbit tail cannot stay long", topic: "animal" },
      {
        zh: "秋后的蚂蚱，蹦跶不了",
        en: "autumn grasshopper cannot hop much longer",
        topic: "animal"
      },
      {
        zh: "门缝里看人，把人看扁了",
        en: "looking through door crack makes people seem flat",
        topic: "person"
      },
      { zh: "肉包子打狗，有去无回", en: "meat bun hits dog and never comes back", topic: "food" },
      {
        zh: "瞎猫碰上死耗子，撞大运",
        en: "blind cat meets dead mouse by pure luck",
        topic: "animal"
      },
      {
        zh: "王婆卖瓜，自卖自夸",
        en: "Granny Wang sells melons praising her own wares",
        topic: "history"
      },
      {
        zh: "关公面前耍大刀，自不量力",
        en: "wielding a blade before Guan Yu overestimates oneself",
        topic: "history"
      },
      {
        zh: "刘备借荆州，有借无还",
        en: "Liu Bei borrows Jingzhou and never returns it",
        topic: "history"
      },
      {
        zh: "周瑜打黄盖，一个愿打一个愿挨",
        en: "Zhou Yu strikes Huang Gai with both sides willing",
        topic: "history"
      },
      {
        zh: "徐庶进曹营，一言不发",
        en: "Xu Shu enters Cao camp saying not a word",
        topic: "history"
      },
      {
        zh: "孙悟空翻筋斗，十万八千里",
        en: "Monkey King somersaults across a vast distance",
        topic: "culture"
      },
      {
        zh: "张飞穿针，大眼瞪小眼",
        en: "Zhang Fei threads needle with big eyes staring",
        topic: "history"
      },
      {
        zh: "韩信点兵，多多益善",
        en: "Han Xin counts troops the more the better",
        topic: "history"
      }
    ]
  }
] as const;

function difficultyFor(globalIndex: number): PromptDifficulty {
  const bucket = globalIndex % 10;
  if (bucket < 2) return "easy";
  if (bucket < 7) return "medium";
  return "hard";
}

for (const group of GROUPS) {
  if (group.items.length < 35) {
    throw new Error(`Word bank category ${group.category} must contain at least 35 entries`);
  }
}

export const WORD_BANK: readonly PromptEntry[] = Object.freeze(
  GROUPS.flatMap((group) =>
    group.items.map((phrase, itemIndex) => ({ group, phrase, itemIndex }))
  ).map(({ group, phrase, itemIndex }, globalIndex) =>
    PromptEntrySchema.parse({
      id: `${group.category}-${String(itemIndex + 1).padStart(2, "0")}`,
      texts: { "zh-CN": phrase.zh, en: phrase.en },
      category: group.category,
      topic: phrase.topic ?? group.topic,
      difficulty: difficultyFor(globalIndex),
      drawability:
        group.category === "proverbs"
          ? 3
          : group.category === "poem-lines" || group.category === "xiehouyu"
            ? 4
            : 5,
      ambiguity: 1 + (globalIndex % 5),
      aiTriviality:
        group.category === "objects" || group.category === "animals" ? 5 : 2 + (globalIndex % 3),
      cultureTags: [...(group.cultureTags ?? [])],
      safety: "all-ages",
      source: "curated",
      version: 4
    })
  )
);
